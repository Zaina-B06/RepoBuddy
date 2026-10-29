"""RepoBuddy local server: hands the map to the screen.

Run:  uvicorn server:app --reload --port 8000
The screen (frontend) asks it things like "what's inside components/?" over http://localhost:8000.
"""
import asyncio
import subprocess
from contextlib import closing
import json
import os
import re
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import requests

import agent
import indexer

app = FastAPI(title="RepoBuddy")

# Only pages served from this computer may talk to the server.
LOCAL_ORIGIN = r"http://(localhost|127\.0\.0\.1)(:\d+)?"

# The repo that's open right now. RepoBuddy works on one repo at a time.
current: dict = {"root": None, "db": None}

# Remember the last repo, so restarting the server doesn't lose it ("No repo is open yet").
LAST = Path.home() / ".repobuddy" / "last_repo.json"


def _remember(root: Path):
    try:
        LAST.parent.mkdir(parents=True, exist_ok=True)
        LAST.write_text(json.dumps({"root": str(root)}), encoding="utf8")
    except OSError:
        pass


def _restore():
    try:
        root = Path(json.loads(LAST.read_text(encoding="utf8"))["root"])
    except (OSError, ValueError, KeyError):
        return
    if root.is_dir():
        current["root"] = root
        current["db"] = indexer.build_index(root, progress=lambda *_: None)  # fast: unchanged files are cached


_restore()


class OpenRequest(BaseModel):
    source: str  # a folder on this computer, or https://github.com/owner/repo


def _db():
    if current["db"] is None:
        raise HTTPException(400, "No repo is open yet. Open a GitHub link or a folder first.")
    return indexer.connect(current["db"], readonly=True)


@app.middleware("http")
async def errors_as_json(request: Request, call_next):
    """If something breaks, send the real reason back (with CORS headers, so the screen can show it)
    instead of a bare 500 that the browser reports as "can't reach the server"."""
    try:
        return await call_next(request)
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        return JSONResponse({"detail": f"Server error: {type(e).__name__}: {e}"}, status_code=500)


# Allow pages on this computer to call the server. Added last, so it also covers error responses.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=LOCAL_ORIGIN,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/api/open")
def open_repo(req: OpenRequest):
    """Open a repo: download it if it's a link, then build (or rebuild) its map."""
    try:
        root = indexer.fetch(req.source)
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e))
    current["root"] = root
    current["db"] = indexer.build_index(root, progress=lambda *_: None)
    _remember(root)
    with closing(_db()) as db:
        return {"root": str(root), "name": root.name, "stats": indexer.stats(db)}


@app.get("/api/folder")
def folder(path: str = "", tests: bool = False):
    """One level of the Folder view: subfolders, files and the arrows between them."""
    with closing(_db()) as db:
        return indexer.folder_view(db, path, include_tests=tests)


@app.get("/api/graph")
def graph(tests: bool = False):
    """Every file and every connection: the Connections view."""
    with closing(_db()) as db:
        return indexer.file_graph(db, include_tests=tests)


def _repo_file(path: str) -> Path:
    """Resolve a repo-relative path, refusing anything outside the open repo."""
    if current["root"] is None:
        raise HTTPException(400, "No repo is open yet.")
    root: Path = current["root"].resolve()
    target = (root / path).resolve()
    if root not in target.parents:
        raise HTTPException(400, f"{path} is outside this repo.")
    return target


@app.get("/api/file")
def file(path: str):
    """The text of one file, for the editor."""
    target = _repo_file(path)
    if not target.is_file():
        raise HTTPException(404, f"No file called {path} in this repo.")
    return {"path": path, "text": target.read_text(encoding="utf8", errors="replace")}


class SaveRequest(BaseModel):
    path: str
    text: str


@app.put("/api/file")
def save_file(req: SaveRequest):
    """Save a file from the editor, then refresh the map so it matches."""
    target = _repo_file(req.path)
    text = req.text
    # keep the file's original line endings (Windows CRLF stays CRLF), so git doesn't see every line as changed
    if target.is_file() and b"\r\n" in target.read_bytes():
        text = text.replace("\r\n", "\n").replace("\n", "\r\n")
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf8", newline="") as f:
        f.write(text)
    current["db"] = indexer.build_index(current["root"], progress=lambda *_: None)
    return {"ok": True}


class FsRequest(BaseModel):
    op: str                    # "new_file", "new_folder", "rename" or "delete"
    path: str
    new_path: str | None = None


@app.post("/api/fs")
def file_op(req: FsRequest):
    """New file, new folder, rename or delete, from the Files panel. Then refresh the map."""
    import shutil
    for p in (req.path, req.new_path or ""):
        if p.replace("\\", "/").strip("/").split("/")[0] == ".git":
            raise HTTPException(400, "RepoBuddy doesn't change files inside .git.")
    target = _repo_file(req.path)
    if req.op == "new_file":
        if target.exists():
            raise HTTPException(400, f"{req.path} already exists.")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("", encoding="utf8")
    elif req.op == "new_folder":
        target.mkdir(parents=True, exist_ok=False) if not target.exists() else None
    elif req.op == "rename":
        if not target.exists():
            raise HTTPException(404, f"{req.path} doesn't exist.")
        dest = _repo_file(req.new_path or "")
        if dest.exists():
            raise HTTPException(400, f"{req.new_path} already exists.")
        dest.parent.mkdir(parents=True, exist_ok=True)
        target.rename(dest)
    elif req.op == "delete":
        if not target.exists():
            raise HTTPException(404, f"{req.path} doesn't exist.")
        shutil.rmtree(target) if target.is_dir() else target.unlink()
    else:
        raise HTTPException(400, f"Unknown operation {req.op}.")
    current["db"] = indexer.build_index(current["root"], progress=lambda *_: None)
    return {"ok": True}


class AskRequest(BaseModel):
    question: str
    focus_file: str | None = None


@app.get("/api/ai")
def ai_status():
    """Is an AI model configured (key in backend/.env)?"""
    return agent.status()


@app.get("/api/models")
def models():
    """Model hosts with keys in backend/.env, and the models each one offers."""
    return agent.catalog()


class ModelRequest(BaseModel):
    provider: str
    model: str


@app.post("/api/model")
def pick_model(req: ModelRequest):
    """Use this model for Ask from now on (remembered across restarts)."""
    try:
        return agent.choose(req.provider, req.model)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/ask")
def ask(req: AskRequest):
    """Ask a question about the open repo. Returns an answer plus numbered, checked steps."""
    if current["root"] is None:
        raise HTTPException(400, "Open a repo first.")
    try:
        with closing(_db()) as db:
            return agent.ask(req.question, current["root"], db, req.focus_file)
    except agent.AiNotConfigured as e:
        raise HTTPException(409, str(e))
    except (RuntimeError, requests.RequestException) as e:
        raise HTTPException(502, str(e))


# ---------------------------------------------------------------- search, git, run

@app.get("/api/search")
def search(q: str, limit: int = 200, folder: str = ""):
    """Search every indexed file for some text (case-insensitive)."""
    if current["root"] is None:
        raise HTTPException(400, "Open a repo first.")
    needle = q.strip().lower()
    if len(needle) < 2:
        return {"query": q, "hits": [], "truncated": False}
    root: Path = current["root"]
    hits = []
    with closing(_db()) as db:
        paths = [r["path"] for r in db.execute("SELECT path FROM files ORDER BY path")]
    folder = folder.strip("/")
    if folder:
        paths = [p for p in paths if p.startswith(folder + "/")]
    for p in paths:
        try:
            lines = (root / p).read_text(encoding="utf8", errors="replace").splitlines()
        except OSError:
            continue
        for i, line in enumerate(lines, 1):
            col = line.lower().find(needle)
            if col >= 0:
                hits.append({"file": p, "line": i, "col": col + 1, "text": line.strip()[:200]})
                if len(hits) >= limit:
                    return {"query": q, "hits": hits, "truncated": True}
    return {"query": q, "hits": hits, "truncated": False}


def _git(*args: str) -> str | None:
    try:
        r = subprocess.run(["git", "-C", str(current["root"]), *args], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout if r.returncode == 0 else None


@app.get("/api/git")
def git_status():
    """Branch, commits ahead/behind, changed files and the git user. Read-only."""
    if current["root"] is None:
        raise HTTPException(400, "Open a repo first.")
    status = _git("status", "--porcelain=v1", "--branch")
    if status is None:
        return {"is_repo": False}
    head, *rest = status.splitlines() or [""]
    m = re.match(r"## (?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?", head)
    branch = m.group(1) if m else "unknown"
    ahead = behind = 0
    if m and m.group(3):
        a = re.search(r"ahead (\d+)", m.group(3)); b = re.search(r"behind (\d+)", m.group(3))
        ahead, behind = int(a.group(1)) if a else 0, int(b.group(1)) if b else 0
    names = {"M": "modified", "A": "added", "D": "deleted", "R": "renamed", "??": "new", "U": "conflict"}
    changes = []
    for line in rest:
        code, path = line[:2].strip(), line[3:]
        if " -> " in path:
            path = path.split(" -> ")[-1]
        changes.append({"path": path, "status": names.get(code, names.get(code[:1], "changed"))})
    branches = [b.strip() for b in (_git("branch", "--format=%(refname:short)") or "").splitlines() if b.strip()]
    return {
        "is_repo": True, "branch": branch, "upstream": m.group(2) if m else None, "ahead": ahead, "behind": behind,
        "changes": changes, "branches": branches,
        "user": {"name": (_git("config", "user.name") or "").strip(), "email": (_git("config", "user.email") or "").strip()},
    }


@app.get("/api/run")
def run_command():
    """The command that starts this project locally, if we can tell (used by Go Live)."""
    if current["root"] is None:
        raise HTTPException(400, "Open a repo first.")
    root: Path = current["root"]
    pkg = root / "package.json"
    if pkg.exists():
        try:
            scripts = json.loads(pkg.read_text(encoding="utf8")).get("scripts", {})
        except ValueError:
            scripts = {}
        for name in ("dev", "start", "serve"):
            if name in scripts:
                return {"command": f"npm run {name}", "needs_install": not (root / "node_modules").exists()}
    if (root / "manage.py").exists():
        return {"command": "python manage.py runserver", "needs_install": False}
    for f in ("app.py", "main.py", "server.py"):
        if (root / f).exists():
            return {"command": f"python {f}", "needs_install": False}
    return {"command": None, "needs_install": False}


@app.get("/api/health")
def health():
    return {"ok": True, "repo": str(current["root"]) if current["root"] else None}


# ---------------------------------------------------------------- terminal
# A real shell (PowerShell on Windows, your usual shell elsewhere) inside the open repo.
# It only runs what you type into it; RepoBuddy itself never runs repo code.

def _spawn_shell(cwd: str):
    if sys.platform == "win32":
        from winpty import PtyProcess  # pip package: pywinpty
        # Use full paths: on some PCs Windows' System32 folder isn't on PATH, so "powershell.exe" alone isn't found.
        win = os.environ.get("SystemRoot", r"C:\Windows")
        for shell in (os.path.join(win, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
                      os.path.join(win, "System32", "cmd.exe")):
            if os.path.exists(shell):
                # pass a list, not a string: pywinpty splits strings without removing quotes, so a quoted path isn't found
                args = [shell, "-NoLogo"] if shell.endswith("powershell.exe") else [shell]
                return PtyProcess.spawn(args, cwd=cwd, dimensions=(24, 100))
        raise FileNotFoundError("Couldn't find PowerShell or cmd.exe in the Windows folder.")
    from ptyprocess import PtyProcessUnicode
    return PtyProcessUnicode.spawn([os.environ.get("SHELL", "/bin/bash")], cwd=cwd, dimensions=(24, 100))


@app.websocket("/api/terminal")
async def terminal(ws: WebSocket):
    origin = ws.headers.get("origin", "")
    if origin and not re.fullmatch(LOCAL_ORIGIN, origin):
        await ws.close(code=1008)
        return
    await ws.accept()
    cwd = str(current["root"] or Path.home())
    try:
        proc = _spawn_shell(cwd)
    except Exception as e:  # noqa: BLE001
        # show why in the terminal itself, instead of closing silently
        import traceback
        traceback.print_exc()
        await ws.send_text(f"\r\n\x1b[31mCouldn't start a shell: {type(e).__name__}: {e}\x1b[0m\r\n")
        await ws.close()
        return
    loop = asyncio.get_running_loop()

    async def pump_output():
        while True:
            try:
                data = await loop.run_in_executor(None, proc.read, 4096)
            except (EOFError, OSError):
                break
            if data:
                await ws.send_text(data)
            elif not proc.isalive():
                break
        await ws.close()

    reader = asyncio.create_task(pump_output())
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if msg.get("type") == "input":
                proc.write(msg["data"])
            elif msg.get("type") == "resize":
                proc.setwinsize(int(msg["rows"]), int(msg["cols"]))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        reader.cancel()
        try:
            proc.terminate(force=True)
        except Exception:
            pass
