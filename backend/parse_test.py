"""
RepoBuddy day-1 test: can we build a correct import graph from a real repo?

Usage:
    python backend/parse_test.py <path-to-repo>

Prints: files parsed, functions/classes found, import edges resolved,
the most-imported files, and a sample of imports it could NOT resolve.
Unresolved *local* imports are the thing to watch: they mean missing graph edges.
"""
import json
import os
import sys
from collections import Counter
from pathlib import Path

import tree_sitter_javascript as tsjs
import tree_sitter_python as tspy
import tree_sitter_typescript as tsts
from tree_sitter import Language, Parser

SKIP_DIRS = {
    "node_modules", ".git", "dist", "build", ".next", "out", "coverage",
    "__pycache__", ".venv", "venv", "env", ".tox", ".mypy_cache", "vendor",
}
MAX_FILE_BYTES = 1_000_000

LANGS = {
    ".py": Language(tspy.language()),
    ".js": Language(tsjs.language()),
    ".jsx": Language(tsjs.language()),
    ".mjs": Language(tsjs.language()),
    ".cjs": Language(tsjs.language()),
    ".ts": Language(tsts.language_typescript()),
    ".tsx": Language(tsts.language_tsx()),
}
JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
ASSET_EXTS = {".css", ".scss", ".sass", ".less", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".json", ".md", ".mdx"}


def walk(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            p = Path(dirpath) / name
            if p.suffix in LANGS and p.stat().st_size <= MAX_FILE_BYTES:
                yield p


def text(node, src: bytes) -> str:
    return src[node.start_byte:node.end_byte].decode("utf8", errors="replace")


def extract(path: Path, src: bytes):
    """Return (imports, symbols). imports = list of raw module strings."""
    tree = Parser(LANGS[path.suffix]).parse(src)
    imports, symbols = [], []
    stack = [tree.root_node]
    while stack:
        n = stack.pop()
        t = n.type
        if path.suffix == ".py":
            if t == "import_statement":
                for c in n.named_children:
                    name = c.child_by_field_name("name") if c.type == "aliased_import" else c
                    imports.append(text(name, src))
            elif t == "import_from_statement":
                mod = n.child_by_field_name("module_name")
                if mod is not None:
                    base = text(mod, src)
                    # `from pkg import x`: x may be a submodule (pkg/x.py) or just a name in pkg.
                    # Try pkg.x first; fall back to pkg. Tuple = (preferred, fallback).
                    names = [c.child_by_field_name("name") if c.type == "aliased_import" else c
                             for c in n.children_by_field_name("name")]
                    if not names:
                        imports.append(base)
                    for nm in names:
                        sub = base + text(nm, src) if base.endswith(".") else base + "." + text(nm, src)
                        imports.append((sub, base))
            elif t in ("function_definition", "class_definition"):
                symbols.append((t, text(n.child_by_field_name("name"), src), n.start_point[0] + 1))
        else:
            if t in ("import_statement", "export_statement"):
                s = n.child_by_field_name("source")
                if s is not None:
                    imports.append(text(s, src).strip("'\"`"))
            elif t == "call_expression":
                fn = n.child_by_field_name("function")
                args = n.child_by_field_name("arguments")
                if fn is not None and args is not None and text(fn, src) in ("require", "import"):
                    for a in args.named_children:
                        if a.type == "string":
                            imports.append(text(a, src).strip("'\"`"))
            elif t in ("function_declaration", "class_declaration", "method_definition"):
                name = n.child_by_field_name("name")
                if name is not None:
                    symbols.append((t, text(name, src), n.start_point[0] + 1))
            elif t == "variable_declarator":
                val = n.child_by_field_name("value")
                if val is not None and val.type in ("arrow_function", "function_expression", "function"):
                    symbols.append(("arrow_function", text(n.child_by_field_name("name"), src), n.start_point[0] + 1))
        stack.extend(n.children)
    return imports, symbols


def load_ts_aliases(root: Path):
    """Read compilerOptions.paths from tsconfig/jsconfig, e.g. {"@/*": ["src/*"]}."""
    aliases = []
    for name in ("tsconfig.json", "jsconfig.json"):
        f = root / name
        if not f.exists():
            continue
        try:
            raw = "\n".join(l for l in f.read_text().splitlines() if not l.strip().startswith("//"))
            opts = json.loads(raw).get("compilerOptions", {})
        except Exception:
            continue
        base = root / opts.get("baseUrl", ".")
        for pattern, targets in opts.get("paths", {}).items():
            for tgt in targets:
                aliases.append((pattern.rstrip("*"), base / tgt.rstrip("*")))
    return aliases


def resolve_js(spec: str, importer: Path, root: Path, files: set, aliases):
    candidates = []
    if spec.startswith("."):
        candidates.append((importer.parent / spec).resolve())
    else:
        for prefix, target in aliases:
            if prefix and spec.startswith(prefix):
                candidates.append((target / spec[len(prefix):]).resolve())
    for c in candidates:
        tries = [c] + [Path(str(c) + e) for e in JS_EXTS] + [c / ("index" + e) for e in JS_EXTS]
        # `./foo.js` written in TS source often means foo.ts
        if c.suffix in (".js", ".jsx"):
            tries += [c.with_suffix(e) for e in (".ts", ".tsx")]
        for t in tries:
            if t in files:
                return t
    return None


def resolve_py(mod: str, importer: Path, root: Path, files: set):
    if mod.startswith("."):
        dots = len(mod) - len(mod.lstrip("."))
        base = importer.parent
        for _ in range(dots - 1):
            base = base.parent
        parts = [p for p in mod.lstrip(".").split(".") if p]
        bases = [base]
    else:
        parts = mod.split(".")
        # absolute imports: try repo root and common source roots
        bases = [root, root / "src"]
    for b in bases:
        p = b.joinpath(*parts) if parts else b
        for t in (p.with_suffix(".py"), p / "__init__.py"):
            if t.resolve() in files:
                return t.resolve()
    return None


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    root = Path(sys.argv[1]).resolve()
    paths = [p.resolve() for p in walk(root)]
    files = set(paths)
    aliases = load_ts_aliases(root)

    edges, unresolved_local, external = set(), Counter(), Counter()
    sym_count = Counter()
    for p in paths:
        try:
            imports, symbols = extract(p, p.read_bytes())
        except Exception as e:
            print(f"  ! failed to parse {p.relative_to(root)}: {e}")
            continue
        for kind, *_ in symbols:
            sym_count[kind] += 1
        for spec in imports:
            fallback = None
            if isinstance(spec, tuple):
                spec, fallback = spec
            if p.suffix != ".py" and Path(spec).suffix in ASSET_EXTS:
                continue  # css/images/json are assets, not code edges
            if p.suffix == ".py":
                target = resolve_py(spec, p, root, files) or (fallback and resolve_py(fallback, p, root, files))
                is_local = spec.startswith(".") or (root / spec.split(".")[0]).exists() or (root / "src" / spec.split(".")[0]).exists()
            else:
                target = resolve_js(spec, p, root, files, aliases)
                is_local = spec.startswith(".") or any(spec.startswith(a) for a, _ in aliases if a)
            if target and target != p:
                edges.add((p, target))
            elif target is None and is_local:
                unresolved_local[f"{p.relative_to(root)}  ->  {fallback or spec}"] += 1
            elif target is None:
                if p.suffix == ".py":
                    external[spec.split(".")[0]] += 1
                else:
                    external[spec.split("/")[0] if not spec.startswith("@") else "/".join(spec.split("/")[:2])] += 1

    indeg = Counter(t for _, t in edges)
    by_lang = Counter(p.suffix for p in paths)

    print(f"\nRepo: {root}")
    print(f"Files parsed: {len(paths)}  " + "  ".join(f"{k}:{v}" for k, v in by_lang.most_common()))
    print("Symbols: " + ", ".join(f"{k} {v}" for k, v in sym_count.most_common()))
    print(f"TS path aliases: {[a for a, _ in aliases] or 'none'}")
    print(f"\nImport edges (file -> file): {len(edges)}")
    print(f"Unresolved LOCAL imports: {sum(unresolved_local.values())}   <- should be near 0")
    print(f"External packages: {len(external)} (top: {', '.join(k for k, _ in external.most_common(8))})")

    print("\nMost imported files (likely core modules):")
    for t, n in indeg.most_common(10):
        print(f"  {n:4d}  {t.relative_to(root)}")
    orphans = [p for p in paths if p not in indeg and not any(s == p for s, _ in edges)]
    print(f"\nFiles with no edges at all: {len(orphans)} of {len(paths)}")

    if unresolved_local:
        print("\nSample unresolved local imports (check these by hand):")
        for k, _ in unresolved_local.most_common(15):
            print("  " + k)


if __name__ == "__main__":
    main()
