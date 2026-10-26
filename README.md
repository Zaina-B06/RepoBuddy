# RepoBuddy

A map for your codebase. Zoom from folders to files to code, ask a question and watch the answer light up as a path through the code, and click anything on your running app to jump to the code behind it.

Built for the Meta Global AI Developer Hackathon (indie developer track), Oct 26 – Nov 4, 2026.

## Built during the hackathon

Everything in this repository was written during the hackathon, starting Oct 26, 2026. The commit history shows the progress day by day.

Third-party libraries used (not written by us): tree-sitter and its language grammars, Monaco Editor, Cytoscape.js, React, FastAPI, Tauri.

## Meta models used

| Model | Role |
| --- | --- |
| Muse Spark 1.3 (Meta Model API) | Answers questions by tracing code with tool calls; summaries; ranking |
| SAM 3.1 (Meta Model API) | Finds UI elements in app screenshots for point-to-code |
| Muse Glimmer (open weights, local) | Private mode: summaries and answers without code leaving the machine |

## Status

- [x] Day 1: tree-sitter import graph tested on Flask, Express and shadcn/taxonomy
- [ ] Indexer
- [ ] Folder and Connections views
- [ ] Editor
- [ ] Ask the repo
- [ ] Private mode
- [ ] Point-to-code

## Run the day-1 checks

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate    Mac/Linux: source .venv/bin/activate
pip install -r requirements.txt
python parse_test.py <path-to-any-repo>
python test_spark.py          # needs MODEL_API_KEY set
```
