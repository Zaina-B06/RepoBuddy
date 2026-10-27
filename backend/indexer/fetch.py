"""Get a repository onto disk: a local folder as-is, or a public GitHub URL via shallow clone."""
from __future__ import annotations

import hashlib
import os
import re
import subprocess
from pathlib import Path

CACHE = Path(os.environ.get("REPOBUDDY_CACHE", Path.home() / ".repobuddy"))
_GITHUB = re.compile(r"^https://github\.com/([\w.-]+)/([\w.-]+?)(?:\.git)?/?$")


def repo_id(root: Path) -> str:
    """Stable id for a repo folder: '<name>-<8 hex>'."""
    h = hashlib.sha1(str(root.resolve()).lower().encode()).hexdigest()[:8]
    return f"{root.resolve().name}-{h}"


def db_path_for(root: Path) -> Path:
    (CACHE / "index").mkdir(parents=True, exist_ok=True)
    return CACHE / "index" / f"{repo_id(root)}.sqlite"


def fetch(source: str, refresh: bool = False) -> Path:
    """Return a local folder for `source` (a path or a public GitHub URL)."""
    m = _GITHUB.match(source.strip())
    if not m:
        root = Path(source).expanduser().resolve()
        if not root.is_dir():
            raise ValueError(f"Not a folder or a public GitHub URL: {source}")
        return root

    owner, name = m.group(1), m.group(2)
    dest = CACHE / "repos" / f"{owner}__{name}"
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1"}
    if dest.exists() and not refresh:
        return dest
    if dest.exists():
        subprocess.run(["git", "-C", str(dest), "pull", "--ff-only", "--depth", "1"],
                       check=True, env=env, capture_output=True, text=True)
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    # --depth 1: latest commit only. No submodules, no LFS files. Nothing from the repo is executed.
    result = subprocess.run(
        ["git", "clone", "--depth", "1", "--single-branch", f"https://github.com/{owner}/{name}.git", str(dest)],
        env=env, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"git clone failed (is the repo public?): {result.stderr.strip()}")
    return dest
