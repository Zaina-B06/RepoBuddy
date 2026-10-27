# RepoBuddy

A map for your codebase. Open any repo (a GitHub link or a folder you already cloned), zoom from folders to files to code, ask a question and watch the answer light up as a path through the code. The map keeps itself up to date as you edit, pull, switch branches and commit.

Built for the Meta Global AI Developer Hackathon (indie developer track), Oct 26 – Nov 4, 2026.

## How the project is organised

```
repobuddy/
├── backend/            Python. Reads code, builds the map, talks to the AI.
│   ├── indexer/        The map-maker: repo -> database of folders, files, functions, imports, routes
│   ├── test_spark.py   Checks that the AI key works
│   ├── requirements.txt  Python libraries we use
│   └── .env.example    Template for secret keys (copy to .env; .env is never committed)
├── frontend/           The screen: graph views, code editor, chat (built next)
├── docs/               PRD and notes
├── README.md           This file
└── .gitignore          Files git should never upload (keys, .venv, caches)
```

The three parts, in build order:

1. **Indexer (backend/indexer)** reads every file and saves a map. No AI involved.
2. **Screen (frontend)** draws that map: Folder view, Connections view, editor.
3. **AI guide (backend, later)** answers questions by finding the path through the map.

## Built during the hackathon

Everything in this repository was written during the hackathon, starting Oct 26, 2026. The commit history shows the progress day by day.

Third-party libraries used (not written by us): tree-sitter and its language grammars, pathspec, Monaco Editor, Cytoscape.js, React, FastAPI, Tauri.

## Meta models used

| Model | Role |
| --- | --- |
| Muse Spark 1.3 (Meta Model API) | Answers questions by tracing code with tool calls; summaries; ranking |
| SAM 3.1 | Finds UI elements in app screenshots for point-to-code |
| Muse Glimmer (open weights, private endpoint) | Private mode: summaries and answers without using a third-party AI service |

## Status

- [x] Repo set up; code-reading tested on Flask, Express and shadcn/taxonomy
- [x] Indexer: repo -> SQLite with folders, files, functions, imports, routes and frontend->backend route links
- [ ] Live sync (re-index on save, pull, branch switch)
- [ ] Screen: Folder view and Connections view
- [ ] Editor
- [ ] Ask the repo
- [ ] Private mode
- [ ] Point-to-code

## Run it

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate    Mac/Linux: source .venv/bin/activate
pip install -r requirements.txt

python -m indexer https://github.com/shadcn-ui/taxonomy
python -m indexer C:\path\to\any\repo --folder src     # one level down, like clicking a folder
```

Indexed maps are stored in `~/.repobuddy/` (one database per repo). Code from indexed repos is only read, never run.
