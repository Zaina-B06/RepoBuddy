"""RepoBuddy local server: hands the map to the screen.

Run:  uvicorn server:app --reload --port 8000
The screen (frontend) asks it things like "what's inside components/?" over http://localhost:8000.
"""
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import indexer

app = FastAPI(title="RepoBuddy")

# Allow the Vite dev page (localhost:5173) to call this server.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# The repo that's open right now. RepoBuddy works on one repo at a time.
current: dict = {"root": None, "db": None}


class OpenRequest(BaseModel):
    source: str  # a folder on this computer, or https://github.com/owner/repo


def _db():
    if current["db"] is None:
        raise HTTPException(400, "No repo is open yet. Open a GitHub link or a folder first.")
    return indexer.connect(current["db"])


@app.post("/api/open")
def open_repo(req: OpenRequest):
    """Open a repo: download it if it's a link, then build (or rebuild) its map."""
    try:
        root = indexer.fetch(req.source)
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e))
    current["root"] = root
    current["db"] = indexer.build_index(root, progress=lambda *_: None)
    db = _db()
    return {"root": str(root), "name": root.name, "stats": indexer.stats(db)}


@app.get("/api/folder")
def folder(path: str = "", tests: bool = False):
    """One level of the Folder view: subfolders, files and the arrows between them."""
    return indexer.folder_view(_db(), path, include_tests=tests)


@app.get("/api/graph")
def graph(tests: bool = False):
    """Every file and every connection: the Connections view."""
    return indexer.file_graph(_db(), include_tests=tests)


@app.get("/api/file")
def file(path: str):
    """The text of one file, for the editor. Only files inside the open repo."""
    if current["root"] is None:
        raise HTTPException(400, "No repo is open yet.")
    root: Path = current["root"]
    target = (root / path).resolve()
    if root.resolve() not in target.parents or not target.is_file():
        raise HTTPException(404, f"No file called {path} in this repo.")
    return {"path": path, "text": target.read_text(encoding="utf8", errors="replace")}


@app.get("/api/health")
def health():
    return {"ok": True, "repo": str(current["root"]) if current["root"] else None}