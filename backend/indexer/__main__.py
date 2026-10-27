"""Index a repo from the command line and print what the UI will show.

    python -m indexer <folder or https://github.com/owner/repo> [--tests] [--folder src/api] [--refresh]
"""
from __future__ import annotations

import argparse

from . import store
from .build import build_index
from .fetch import fetch


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m indexer")
    ap.add_argument("source", help="local folder or public GitHub URL")
    ap.add_argument("--tests", action="store_true", help="include test files in the views")
    ap.add_argument("--folder", default="", help="folder to show in the Folder view (default: repo root)")
    ap.add_argument("--refresh", action="store_true", help="re-download a GitHub repo")
    args = ap.parse_args()

    root = fetch(args.source, refresh=args.refresh)
    db_path = build_index(root)
    db = store.connect(db_path)

    s = store.stats(db)
    print(f"\nRepo: {root}")
    print(f"Files: {s['files']}  ({', '.join(f'{k} {v}' for k, v in sorted(s['files_by_kind'].items()))})"
          f"   Folders: {s['folders']}   Symbols: {s['symbols']}")
    print(f"Import edges: {s['import_edges']}   Unresolved local imports: {s['unresolved_local']}")
    print(f"Routes defined: {s['routes']}   HTTP calls: {s['http_calls']}   Route links: {s['route_edges']}")

    print("\nCore files (PageRank over imports, tests excluded):")
    for r in db.execute("SELECT path, rank, in_degree FROM files WHERE kind != 'test' ORDER BY rank DESC LIMIT 8"):
        print(f"  {r['rank']:.2f}  imported by {r['in_degree']:3d}  {r['path']}")

    entries = [r["path"] for r in db.execute("SELECT path FROM files WHERE is_entry = 1 ORDER BY path LIMIT 10")]
    print(f"\nEntry points: {', '.join(entries) or 'none found'}")

    view = store.folder_view(db, args.folder, include_tests=args.tests)
    print(f"\nFolder view of '{args.folder or '(root)'}': {len(view['nodes'])} nodes")
    for n in view["nodes"][:15]:
        label = f"{n['files']} files" if n["type"] == "folder" else n["kind"] + (", entry" if n.get("entry") else "")
        print(f"  {n['type']:<6} {n['name']:<28} {n['loc']:6d} lines   {label}")
    if len(view["nodes"]) > 15:
        print(f"  ... {len(view['nodes']) - 15} more")
    print("  Arrows:")
    for e in view["edges"][:12]:
        print(f"    {e['source'] or '(root)'} -> {e['target']}: {e['count']} {e['kind']}s")
    if not view["edges"]:
        print("    none at this level")

    links = db.execute("SELECT src, dst, detail, confidence FROM edges WHERE kind = 'route' LIMIT 8").fetchall()
    if links:
        print("\nRoute links (frontend call -> backend handler, dashed in the graph):")
        for r in links:
            print(f"  {r['src']}  --{r['detail']}-->  {r['dst']}  ({r['confidence']})")

    bad = db.execute("SELECT file, spec FROM unresolved LIMIT 8").fetchall()
    if bad:
        print("\nUnresolved local imports (check by hand):")
        for r in bad:
            print(f"  {r['file']} -> {r['spec']}")
    db.close()


if __name__ == "__main__":
    main()
