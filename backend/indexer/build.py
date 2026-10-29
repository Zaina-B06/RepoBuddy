"""Build (or rebuild) the index for one repository.

Pipeline (PRD, "Indexing pipeline"): walk -> parse -> link -> score -> store.
Summaries are written later by the model layer; they survive re-indexing when a file's
content (sha1) has not changed.
"""
from __future__ import annotations

import hashlib
import json
import os
import posixpath
import re
import time
from pathlib import Path

import pathspec

from . import resolve, store
from .fetch import db_path_for
from .parse import LANG_BY_EXT, parse_file

SKIP_DIRS = {"node_modules", ".git", "dist", "build", ".next", "out", "coverage", "__pycache__",
             ".venv", "venv", "env", ".tox", ".mypy_cache", ".pytest_cache", "vendor", "target",
             ".turbo", ".cache", "site-packages", "bower_components"}
MAX_FILE_BYTES = 1_000_000
MAX_FILES = 5_000

_TEST = re.compile(r"(^|/)(tests?|__tests__|spec|specs|e2e|cypress|testing)(/|$)"
                   r"|(^|/)test_[^/]*\.py$|_test\.py$|\.(test|spec)\.[jt]sx?$|(^|/)conftest\.py$")
_CONFIG = re.compile(r"(^|/)(setup\.py|settings\.py|config\.py|conf\.py|noxfile\.py|"
                     r"[^/]*\.config\.(js|ts|mjs|cjs)|[^/]*rc\.(js|cjs)|env\.(mjs|js|ts))$")
_ENTRY_NAMES = {"main.py", "app.py", "manage.py", "wsgi.py", "asgi.py", "__main__.py", "server.py",
                "index.js", "index.ts", "server.js", "server.ts", "app.js", "app.ts", "main.ts", "main.js",
                "main.tsx", "index.tsx", "layout.tsx", "page.tsx"}


def _load_gitignore(root: Path) -> pathspec.PathSpec | None:
    f = root / ".gitignore"
    if not f.exists():
        return None
    try:
        return pathspec.PathSpec.from_lines("gitwildmatch", f.read_text(encoding="utf8", errors="replace").splitlines())
    except Exception:
        return None


def walk(root: Path) -> list[str]:
    ignore = _load_gitignore(root)
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = Path(dirpath).relative_to(root).as_posix()
        rel_dir = "" if rel_dir == "." else rel_dir
        keep = []
        for d in dirnames:
            rel = f"{rel_dir}/{d}" if rel_dir else d
            if d in SKIP_DIRS or d.startswith(".") or (ignore and ignore.match_file(rel + "/")):
                continue
            keep.append(d)
        dirnames[:] = sorted(keep)
        for name in sorted(filenames):
            rel = f"{rel_dir}/{name}" if rel_dir else name
            ext = posixpath.splitext(name)[1]
            if ext not in LANG_BY_EXT or name.endswith(".d.ts"):
                continue
            if ignore and ignore.match_file(rel):
                continue
            if (root / rel).stat().st_size > MAX_FILE_BYTES:
                continue
            out.append(rel)
            if len(out) >= MAX_FILES:
                return out
    return out


_PY_DOC = re.compile(r'^\s*(?:#[^\n]*\n\s*)*[rRuU]?("""|\'\'\')(.*?)\1', re.S)
_JS_BLOCK = re.compile(r"^\s*(?:(?:\"use \w+\";?|'use \w+';?)\s*)?/\*\*?(.*?)\*/", re.S)
_JS_LINES = re.compile(r"^\s*((?://[^\n]*\n\s*)+)")


def file_blurb(text: str, lang: str) -> str | None:
    """The first sentence of a file's own top comment or docstring, if the author wrote one."""
    head = text[:3000]
    raw = None
    if lang == "python":
        m = _PY_DOC.match(head)
        raw = m.group(2) if m else None
    else:
        m = _JS_BLOCK.match(head)
        if m:
            raw = re.sub(r"^\s*\*\s?", "", m.group(1), flags=re.M)
        else:
            m = _JS_LINES.match(head)
            if m:
                raw = re.sub(r"^\s*//\s?", "", m.group(1), flags=re.M)
    if not raw:
        return None
    raw = " ".join(l.strip() for l in raw.strip().splitlines() if l.strip() and not l.strip().startswith(("@", "eslint", "prettier", "ts-", "#!")))
    if len(raw) < 12 or raw.lower().startswith(("copyright", "license", "(c)", "eslint", "todo", "fixme", "hack", "xxx", "note:")):
        return None
    first = re.split(r"(?<=[.!?])\s", raw, maxsplit=1)[0]
    return (first[:157] + "…") if len(first) > 160 else first


def classify(path: str) -> str:
    if _TEST.search(path):
        return "test"
    if _CONFIG.search(path):
        return "config"
    return "code"


def _package_json_entries(root: Path) -> set[str]:
    f = root / "package.json"
    entries: set[str] = set()
    if not f.exists():
        return entries
    try:
        pkg = json.loads(f.read_text(encoding="utf8", errors="replace"))
    except ValueError:
        return entries
    for key in ("main", "module"):
        if isinstance(pkg.get(key), str):
            entries.add(posixpath.normpath(pkg[key]))
    b = pkg.get("bin")
    for v in ([b] if isinstance(b, str) else list(b.values()) if isinstance(b, dict) else []):
        entries.add(posixpath.normpath(v))
    return entries


def pagerank(nodes: list[str], edges: list[tuple[str, str]], iters: int = 40, d: float = 0.85) -> dict[str, float]:
    """A file is important if important files import it."""
    n = len(nodes)
    if n == 0:
        return {}
    out: dict[str, list[str]] = {v: [] for v in nodes}
    for s, t in edges:
        if s in out and t in out:
            out[s].append(t)
    rank = {v: 1.0 / n for v in nodes}
    for _ in range(iters):
        sink = sum(rank[v] for v in nodes if not out[v])
        new = {v: (1 - d) / n + d * sink / n for v in nodes}
        for s in nodes:
            if out[s]:
                share = d * rank[s] / len(out[s])
                for t in out[s]:
                    new[t] += share
        rank = new
    top = max(rank.values())
    return {v: r / top for v, r in rank.items()}   # 1.0 = most central file


def build_index(root: Path, db_path: Path | None = None, progress=print) -> Path:
    t0 = time.time()
    root = root.resolve()
    db_path = db_path or db_path_for(root)
    db = store.connect(db_path)
    if "blurb" not in [r[1] for r in db.execute("PRAGMA table_info(files)")]:
        db.close()
        db_path.unlink()
        db = store.connect(db_path)

    # keep summaries whose file content has not changed (the "hash cache")
    old_summaries = {r["path"]: (r["summary"], r["summary_sha1"]) for r in
                     db.execute("SELECT path, summary, summary_sha1 FROM files WHERE summary IS NOT NULL")}
    old_folder_summaries = {r["path"]: r["summary"] for r in
                            db.execute("SELECT path, summary FROM folders WHERE summary IS NOT NULL")}
    store.reset(db)

    progress("Scanning files...")
    paths = walk(root)
    files = set(paths)
    progress(f"  {len(paths)} source files")

    progress("Parsing code...")
    parsed = {}
    for p in paths:
        raw = (root / p).read_bytes()
        try:
            parsed[p] = (parse_file(posixpath.splitext(p)[1], raw), raw)
        except Exception as e:  # one broken file must never stop indexing
            progress(f"  ! could not parse {p}: {e}")

    progress("Linking imports and routes...")
    aliases = resolve.load_js_aliases(root)
    py_roots = resolve.python_roots(files)
    py_tops = resolve.python_local_tops(files, py_roots)
    pkg_entries = _package_json_entries(root)
    edges: set[tuple[str, str, int, str]] = set()

    for p, (info, raw) in parsed.items():
        sha = hashlib.sha1(raw).hexdigest()
        kind = classify(p)
        name = posixpath.basename(p)
        depth = p.count("/")
        is_entry = (p in pkg_entries or info.has_main_guard
                    or (name in _ENTRY_NAMES and depth <= 1 and kind == "code")
                    or (name in ("layout.tsx", "page.tsx") and re.match(r"^(src/)?app/[^/]+$", p) is not None))
        summary, summary_sha = old_summaries.get(p, (None, None))
        if summary_sha != sha:
            summary, summary_sha = None, None
        loc = raw.count(b"\n") + (0 if raw.endswith(b"\n") or not raw else 1)
        blurb = file_blurb(raw.decode("utf8", errors="replace"), info.lang)
        db.execute("INSERT INTO files (path, folder, lang, size, loc, sha1, kind, is_entry, summary, summary_sha1, blurb)"
                   " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                   (p, posixpath.dirname(p), info.lang, len(raw), loc, sha, kind, int(is_entry), summary, summary_sha, blurb))
        db.executemany("INSERT INTO symbols (file, name, kind, start_line, end_line, exported) VALUES (?,?,?,?,?,?)",
                       [(p, s.name, s.kind, s.start, s.end, int(s.exported)) for s in info.symbols])
        # tests call routes (supertest, test clients); they don't define the app's API
        for r in ([] if kind == "test" else info.routes):
            db.execute("INSERT INTO routes VALUES (?,?,?,?,?,?)", (p, r.method, r.path, r.line, r.handler, "code"))
        for c in ([] if kind == "test" else info.http_calls):
            db.execute("INSERT INTO http_calls VALUES (?,?,?,?)", (p, c.method, c.url, c.line))

        # Next.js file-based API routes
        nr = resolve.next_route_for(p)
        if nr:
            methods = [s.name for s in info.symbols if s.exported and s.name in
                       ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")] or ["ANY"]
            for m in methods:
                db.execute("INSERT INTO routes VALUES (?,?,?,?,?,?)", (p, m, nr, 1, m, "nextjs"))

        for imp in info.imports:
            if info.lang == "python":
                target = resolve.resolve_py(imp.spec, p, files, py_roots)
                if target is None and imp.fallback:
                    target = resolve.resolve_py(imp.fallback, p, files, py_roots)
                local = resolve.py_is_local(imp.fallback or imp.spec, py_tops)
            else:
                if resolve.is_asset(imp.spec):
                    continue
                target = resolve.resolve_js(imp.spec, p, files, aliases)
                local = resolve.js_is_local(imp.spec, aliases)
            if target and target != p:
                edges.add((p, target, imp.line, imp.spec))
            elif target is None and local:
                db.execute("INSERT INTO unresolved VALUES (?,?,?)", (p, imp.fallback or imp.spec, imp.line))

    # one edge per (src, dst) pair, keeping the first import line
    seen: dict[tuple[str, str], tuple[int, str]] = {}
    for s, t, line, spec in sorted(edges, key=lambda e: e[2]):
        seen.setdefault((s, t), (line, spec))
    db.executemany("INSERT INTO edges (src, dst, kind, line, detail, confidence) VALUES (?,?,'import',?,?,'exact')",
                   [(s, t, line, spec) for (s, t), (line, spec) in seen.items()])

    # route edges: frontend call -> file that defines the matching backend route
    routes = db.execute("SELECT file, method, path FROM routes").fetchall()
    route_edges = 0
    for call in db.execute("SELECT file, method, url, line FROM http_calls").fetchall():
        best = None
        for r in routes:
            if r["file"] == call["file"]:
                continue
            how = resolve.match_route(call["url"], call["method"], r["path"], r["method"])
            if how and (best is None or (how == "exact" and best[1] != "exact")):
                best = (r, how)
        if best:
            r, how = best
            db.execute("INSERT INTO edges (src, dst, kind, line, detail, confidence) VALUES (?,?,'route',?,?,?)",
                       (call["file"], r["file"], call["line"], f"{call['method']} {call['url']}", how))
            route_edges += 1

    progress("Scoring files...")
    kinds = {r["path"]: r["kind"] for r in db.execute("SELECT path, kind FROM files")}
    nontest = [p for p in paths if kinds.get(p) != "test"]
    nontest_set = set(nontest)
    import_edges = [(s, t) for (s, t) in seen if s in nontest_set and t in nontest_set]
    ranks = pagerank(nontest, import_edges)
    indeg: dict[str, int] = {}
    for _, t in import_edges:
        indeg[t] = indeg.get(t, 0) + 1
    db.executemany("UPDATE files SET rank = ?, in_degree = ? WHERE path = ?",
                   [(ranks.get(p, 0.0), indeg.get(p, 0), p) for p in paths])

    # folders: every directory that holds indexed files, plus its ancestors
    agg: dict[str, list[int]] = {"": [0, 0]}
    for r in db.execute("SELECT path, loc FROM files"):
        parts = r["path"].split("/")[:-1]
        for i in range(len(parts) + 1):
            f = "/".join(parts[:i])
            agg.setdefault(f, [0, 0])
            agg[f][0] += 1
            agg[f][1] += r["loc"]
    db.executemany("INSERT INTO folders (path, parent, depth, file_count, loc, summary) VALUES (?,?,?,?,?,?)",
                   [(f, (posixpath.dirname(f) if f else None), (f.count("/") + 1 if f else 0), n, loc,
                     old_folder_summaries.get(f)) for f, (n, loc) in agg.items()])

    db.executemany("INSERT INTO meta VALUES (?,?)", [
        ("root", str(root)), ("indexed_at", time.strftime("%Y-%m-%dT%H:%M:%S")),
        ("aliases", json.dumps(aliases)), ("seconds", f"{time.time() - t0:.1f}")])
    db.commit()
    db.close()
    progress(f"Done in {time.time() - t0:.1f}s -> {db_path}")
    return db_path
