"""SQLite storage for one indexed repository, plus the queries the UI needs."""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS folders (
    path TEXT PRIMARY KEY,        -- '' is the repo root
    parent TEXT,
    depth INTEGER,
    file_count INTEGER DEFAULT 0, -- all indexed files below, recursively
    loc INTEGER DEFAULT 0,
    summary TEXT
);

CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    folder TEXT,
    lang TEXT,
    size INTEGER,
    loc INTEGER,
    sha1 TEXT,
    kind TEXT,                    -- code | test | config
    is_entry INTEGER DEFAULT 0,
    rank REAL DEFAULT 0,          -- PageRank over imports, test files excluded
    in_degree INTEGER DEFAULT 0,  -- imported by how many non-test files
    summary TEXT,
    summary_sha1 TEXT,            -- sha1 the summary was written for (cache key)
    blurb TEXT                    -- the file's own top comment or docstring, if it has one
);

CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY,
    file TEXT, name TEXT, kind TEXT,
    start_line INTEGER, end_line INTEGER, exported INTEGER
);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file);

CREATE TABLE IF NOT EXISTS edges (
    src TEXT, dst TEXT,
    kind TEXT,                    -- import | route
    line INTEGER,
    detail TEXT,                  -- import specifier, or "GET /api/x"
    confidence TEXT               -- exact | suffix (route edges are inferred)
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);

CREATE TABLE IF NOT EXISTS routes (
    file TEXT, method TEXT, path TEXT, line INTEGER, handler TEXT, source TEXT
);
CREATE TABLE IF NOT EXISTS http_calls (
    file TEXT, method TEXT, url TEXT, line INTEGER
);
CREATE TABLE IF NOT EXISTS unresolved (
    file TEXT, spec TEXT, line INTEGER
);
"""


def connect(db_path: Path, readonly: bool = False) -> sqlite3.Connection:
    """Open the map database. Readers use read-only mode, so they never block the indexer
    (on Windows, two connections writing at once caused "database is locked" errors)."""
    if readonly:
        db = sqlite3.connect(f"file:{Path(db_path).as_posix()}?mode=ro", uri=True, timeout=10, check_same_thread=False)
    else:
        db = sqlite3.connect(db_path, timeout=10)
        db.executescript(SCHEMA)
    db.row_factory = sqlite3.Row
    return db


def reset(db: sqlite3.Connection) -> None:
    for t in ("folders", "files", "symbols", "edges", "routes", "http_calls", "unresolved", "meta"):
        db.execute(f"DELETE FROM {t}")


# ---------------------------------------------------------------- queries for the UI

def _child_of(folder: str, path: str) -> str | None:
    """Which immediate child of `folder` contains `path` (a file or folder path)?"""
    prefix = folder + "/" if folder else ""
    if not path.startswith(prefix):
        return None
    rest = path[len(prefix):]
    first = rest.split("/")[0]
    return prefix + first


def _file_details(db: sqlite3.Connection, paths: list[str]) -> dict[str, dict]:
    """What each file defines: its main functions/classes and any API routes. Used for hover cards."""
    out: dict[str, dict] = {p: {"defines": [], "routes": []} for p in paths}
    if not paths:
        return out
    marks = ",".join("?" * len(paths))
    for r in db.execute(f"SELECT file, name, kind, exported FROM symbols WHERE file IN ({marks}) AND kind != 'method'"
                        " ORDER BY exported DESC, start_line", paths):
        d = out[r["file"]]["defines"]
        if len(d) < 5 and r["name"] not in d:
            d.append(r["name"])
    for r in db.execute(f"SELECT file, method, path FROM routes WHERE file IN ({marks})", paths):
        rt = out[r["file"]]["routes"]
        if len(rt) < 4:
            rt.append(f"{r['method']} {r['path']}")
    return out


def folder_view(db: sqlite3.Connection, folder: str = "", include_tests: bool = False) -> dict:
    """Nodes = immediate subfolders + files in `folder`; edges = imports between them, aggregated.

    This is exactly what the Folder view (F2) draws at one zoom level.
    """
    nodes = []
    for r in db.execute("SELECT path, file_count, loc, summary FROM folders WHERE parent = ? AND path != ''"
                        " ORDER BY loc DESC", (folder,)):
        top = [t["path"].split("/")[-1] for t in db.execute(
            "SELECT path FROM files WHERE (path LIKE ? || '/%') AND kind != 'test' ORDER BY rank DESC LIMIT 3", (r["path"],))]
        nodes.append({"id": r["path"], "type": "folder", "name": r["path"].split("/")[-1],
                      "files": r["file_count"], "loc": r["loc"], "summary": r["summary"], "key_files": top})
    kind_filter = "" if include_tests else " AND kind != 'test'"
    rows = db.execute("SELECT path, loc, kind, is_entry, rank, in_degree, summary, blurb FROM files"
                      f" WHERE folder = ?{kind_filter} ORDER BY path", (folder,)).fetchall()
    details = _file_details(db, [r["path"] for r in rows])
    for r in rows:
        nodes.append({"id": r["path"], "type": "file", "name": r["path"].split("/")[-1],
                      "loc": r["loc"], "kind": r["kind"], "entry": bool(r["is_entry"]),
                      "rank": r["rank"], "in_degree": r["in_degree"], "summary": r["summary"],
                      "blurb": r["blurb"], **details[r["path"]]})
    if not include_tests:
        # hide folders that contain only tests
        has_code = {r["folder"] for r in db.execute("SELECT DISTINCT folder FROM files WHERE kind != 'test'")}
        nodes = [n for n in nodes if n["type"] == "file"
                 or any(f == n["id"] or f.startswith(n["id"] + "/") for f in has_code)]

    test_files = set() if include_tests else {
        r["path"] for r in db.execute("SELECT path FROM files WHERE kind = 'test'")}
    counts: dict[tuple[str, str, str], int] = {}
    for e in db.execute("SELECT src, dst, kind FROM edges"):
        if e["src"] in test_files or e["dst"] in test_files:
            continue
        a, b = _child_of(folder, e["src"]), _child_of(folder, e["dst"])
        if a and b and a != b:
            key = (a, b, e["kind"])
            counts[key] = counts.get(key, 0) + 1
    edges = [{"source": a, "target": b, "kind": k, "count": n}
             for (a, b, k), n in sorted(counts.items(), key=lambda x: -x[1])]
    return {"folder": folder, "nodes": nodes, "edges": edges}


def file_graph(db: sqlite3.Connection, include_tests: bool = False) -> dict:
    """Every file and every edge: the Connections view (F3)."""
    kind_filter = "" if include_tests else " WHERE kind != 'test'"
    nodes = [dict(r) for r in db.execute(
        f"SELECT path AS id, folder, lang, loc, kind, is_entry, rank, in_degree, summary, blurb FROM files{kind_filter}")]
    details = _file_details(db, [n["id"] for n in nodes])
    for n in nodes:
        n.update(details[n["id"]])
    ids = {n["id"] for n in nodes}
    edges = [dict(r) for r in db.execute("SELECT src AS source, dst AS target, kind, confidence FROM edges")
             if r["source"] in ids and r["target"] in ids]
    return {"nodes": nodes, "edges": edges}


def stats(db: sqlite3.Connection) -> dict:
    one = lambda q: db.execute(q).fetchone()[0]
    return {
        "files": one("SELECT COUNT(*) FROM files"),
        "files_by_kind": {r[0]: r[1] for r in db.execute("SELECT kind, COUNT(*) FROM files GROUP BY kind")},
        "folders": one("SELECT COUNT(*) FROM folders"),
        "symbols": one("SELECT COUNT(*) FROM symbols"),
        "import_edges": one("SELECT COUNT(*) FROM edges WHERE kind = 'import'"),
        "route_edges": one("SELECT COUNT(*) FROM edges WHERE kind = 'route'"),
        "routes": one("SELECT COUNT(*) FROM routes"),
        "http_calls": one("SELECT COUNT(*) FROM http_calls"),
        "unresolved_local": one("SELECT COUNT(*) FROM unresolved"),
    }
