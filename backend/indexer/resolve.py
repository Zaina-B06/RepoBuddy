"""Turn raw import specifiers into file-to-file edges, and match HTTP calls to routes.

All paths here are repo-relative POSIX strings ("src/api/users.ts"), so the index is
identical on Windows, macOS and Linux.
"""
from __future__ import annotations

import json
import posixpath
import re
from pathlib import Path

JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
ASSET_EXTS = {".css", ".scss", ".sass", ".less", ".svg", ".png", ".jpg", ".jpeg", ".gif",
              ".webp", ".ico", ".json", ".md", ".mdx", ".html", ".txt", ".wasm"}


# ---------------------------------------------------------------- JS / TS imports

def load_js_aliases(root: Path) -> list[tuple[str, str]]:
    """compilerOptions.paths from tsconfig/jsconfig, e.g. ("@/", "src/")."""
    aliases: list[tuple[str, str]] = []
    for name in ("tsconfig.json", "jsconfig.json"):
        f = root / name
        if not f.exists():
            continue
        try:
            raw = f.read_text(encoding="utf8", errors="replace")
            raw = re.sub(r"^\s*//.*$", "", raw, flags=re.M)      # line comments
            raw = re.sub(r",(\s*[}\]])", r"\1", raw)              # trailing commas
            opts = json.loads(raw).get("compilerOptions", {})
        except (ValueError, OSError):
            continue
        base = posixpath.normpath(opts.get("baseUrl", "."))
        for pattern, targets in (opts.get("paths") or {}).items():
            for tgt in targets:
                prefix = pattern.rstrip("*")
                target = posixpath.normpath(posixpath.join(base, tgt.rstrip("*")))
                target = "" if target == "." else target.rstrip("/") + "/"
                if prefix:
                    aliases.append((prefix, target))
    # longest prefix first, so "@/components/" beats "@/"
    return sorted(aliases, key=lambda a: -len(a[0]))


def is_asset(spec: str) -> bool:
    return posixpath.splitext(spec)[1].lower() in ASSET_EXTS


def resolve_js(spec: str, importer: str, files: set[str], aliases) -> str | None:
    if spec.startswith("."):
        bases = [posixpath.normpath(posixpath.join(posixpath.dirname(importer), spec))]
    else:
        bases = [posixpath.normpath(target + spec[len(prefix):])
                 for prefix, target in aliases if spec.startswith(prefix)]
    for b in bases:
        if b in (".", ""):                         # require('../..') pointing at the repo root
            tries = ["index" + e for e in JS_EXTS]
            for t in tries:
                if t in files:
                    return t
            continue
        tries = [b] + [b + e for e in JS_EXTS] + [b + "/index" + e for e in JS_EXTS]
        stem, ext = posixpath.splitext(b)
        if ext in (".js", ".jsx", ".mjs"):        # TS source importing "./foo.js" means foo.ts
            tries += [stem + e for e in (".ts", ".tsx", ".mts")]
        for t in tries:
            if t in files:
                return t
    return None


def js_is_local(spec: str, aliases) -> bool:
    return spec.startswith(".") or any(spec.startswith(p) for p, _ in aliases)


# ---------------------------------------------------------------- python imports

def python_roots(files: set[str]) -> list[str]:
    """Folders that act as import roots: the repo root, plus src/ style layouts."""
    roots = [""]
    for f in files:
        if f.endswith(".py") and f.count("/") >= 1:
            top = f.split("/")[0]
            if top in ("src", "lib", "app", "backend", "server") and top + "/" not in roots:
                roots.append(top + "/")
    return roots


def resolve_py(mod: str, importer: str, files: set[str], roots: list[str]) -> str | None:
    if mod.startswith("."):
        dots = len(mod) - len(mod.lstrip("."))
        base = posixpath.dirname(importer)
        for _ in range(dots - 1):
            base = posixpath.dirname(base)
        parts = [p for p in mod.lstrip(".").split(".") if p]
        bases = [base]
    else:
        parts = mod.split(".")
        bases = [r.rstrip("/") for r in roots]
    for b in bases:
        p = posixpath.join(b, *parts) if parts else b
        p = p.lstrip("/")
        for t in (p + ".py", posixpath.join(p, "__init__.py")):
            if t in files:
                return t
    return None


def python_local_tops(files: set[str], roots: list[str]) -> set[str]:
    """Top-level module names that exist in the repo (so `import x` is local)."""
    tops = set()
    for f in files:
        if not f.endswith(".py"):
            continue
        for r in roots:
            if f.startswith(r):
                first = f[len(r):].split("/")[0]
                tops.add(first[:-3] if first.endswith(".py") else first)
    return tops


def py_is_local(mod: str, local_tops: set[str]) -> bool:
    return mod.startswith(".") or mod.split(".")[0] in local_tops


# ---------------------------------------------------------------- Next.js file routes

_NEXT_APP = re.compile(r"(?:^|/)app/(.*?)/?route\.(?:ts|js|tsx|jsx|mjs)$")
_NEXT_PAGES = re.compile(r"(?:^|/)pages/(api/.*)\.(?:ts|js|tsx|jsx)$")


def next_route_for(path: str) -> str | None:
    """app/api/posts/[postId]/route.ts -> /api/posts/:postId ; pages/api/x.ts -> /api/x"""
    m = _NEXT_APP.search(path)
    if m:
        segs = [s for s in m.group(1).split("/") if s and not (s.startswith("(") and s.endswith(")"))]
    else:
        m = _NEXT_PAGES.search(path)
        if not m:
            return None
        segs = m.group(1).split("/")
        if segs[-1] == "index":
            segs = segs[:-1]
    return "/" + "/".join(segs)


# ---------------------------------------------------------------- route matching

def _norm_segments(path: str) -> list[str]:
    segs = []
    for s in path.split("?")[0].strip("/").split("/"):
        if not s:
            continue
        if (s.startswith(":") or s.startswith("[") or s.startswith("{") or s.startswith("<")
                or ":param" in s or s in ("*", "(.*)")):
            segs.append("*")
        else:
            segs.append(s.lower())
    return segs


def _methods_compatible(call_method: str, route_method: str) -> bool:
    if route_method in ("ANY", "ALL", "USE"):
        return True
    return call_method in route_method.split(",") or (call_method == "GET" and route_method == "HEAD")


def match_route(call_url: str, call_method: str, route_path: str, route_method: str) -> str | None:
    """Return "exact", "suffix" (route mounted under an unknown prefix) or None."""
    if not _methods_compatible(call_method, route_method):
        return None
    c, r = _norm_segments(call_url), _norm_segments(route_path)
    if not r or sum(1 for s in r if s != "*") == 0:
        return None
    def same(a, b):
        return len(a) == len(b) and all(x == y or x == "*" or y == "*" for x, y in zip(a, b))
    if same(c, r):
        return "exact"
    literal = sum(1 for s in r if s != "*")
    if len(r) >= 2 and literal >= 1 and len(c) > len(r) and same(c[-len(r):], r):
        return "suffix"
    return None
