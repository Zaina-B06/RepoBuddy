// RepoBuddy: the whole screen. Holds the app's state and arranges the pieces.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { AiStatus, FolderView, GitStatus, Graph } from "./api";
import { AskPanel } from "./components/AskPanel";
import type { Turn } from "./components/AskPanel";
import { ForceMap } from "./components/ForceMap";
import type { MapNodeInput } from "./components/ForceMap";
import { FileTree } from "./components/FileTree";
import type { TreeActions } from "./components/FileTree";
import { BottomPanel } from "./components/BottomPanel";
import type { OpenFile } from "./components/BottomPanel";
import { OpenScreen } from "./components/OpenScreen";
import { MoonIcon, SunIcon } from "./components/Icons";
import { Rail } from "./components/Rail";
import type { Popup, SidePanel } from "./components/Rail";
import { MenuBar } from "./components/MenuBar";
import type { Menu } from "./components/MenuBar";
import { StatusBar } from "./components/StatusBar";
import { AccountCard, GitPanel, PanelHead, SearchPanel, SettingsCard } from "./components/SidePanels";

// Layout, in pixels. Everything floats on the map as rounded sheets with a 16px margin.
const RAIL = 16 + 52 + 10;      // where side panels start (after the rail)
const SIDE_W = 256;
const BOTTOM = 12 + 34 + 10;    // space kept for the status bar
const ASK_W = 316;

type Theme = "light" | "dark";

function load<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    if (v && allowed.includes(v)) return v;
  } catch { /* storage unavailable */ }
  return fallback;
}
function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

// Ask again a few times if the server is briefly away (for example while it restarts).
async function retry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

export default function App() {
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const [theme, setThemeState] = useState<Theme>(() => {
    const t = load("rb-theme", ["light", "dark"], prefersDark ? "dark" : "light");
    document.documentElement.dataset.theme = t;
    return t;
  });
  const setTheme = (t: Theme) => {
    document.documentElement.dataset.theme = t; // before the map redraws, so it picks up the new colours
    setThemeState(t);
  };
  const [dim, setDim] = useState<"3d" | "2d">(() => load("rb-dim", ["3d", "2d"], "3d"));
  const [repo, setRepo] = useState<string | null>(null);
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState<"folder" | "graph">("folder");
  const [folder, setFolder] = useState("");
  const [folderData, setFolderData] = useState<FolderView | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [side, setSide] = useState<SidePanel | null>(() => {
    const v = load<SidePanel | "none">("rb-side", ["files", "search", "git", "none"], "files");
    return v === "none" ? null : v;
  });
  const [popup, setPopup] = useState<Popup | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [run, setRun] = useState<{ command: string; nonce: number } | undefined>(undefined);
  const [searchScope, setSearchScope] = useState("");
  const [draft, setDraft] = useState<{ text: string; nonce: number } | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2200);
    return () => clearTimeout(t);
  }, [notice]);
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [active, setActive] = useState<string>("");
  const [terminalOn, setTerminalOn] = useState(false);
  const [panelHeight, setPanelHeight] = useState(300);
  const [error, setError] = useState<{ message: string; retry?: () => void } | null>(null);
  const [askOpen, setAskOpen] = useState(true);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [path, setPath] = useState<{ turn: number; step: number | null } | null>(null); // answer shown on the map
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => save("rb-theme", theme), [theme]);
  useEffect(() => save("rb-dim", dim), [dim]);
  useEffect(() => save("rb-side", side ?? "none"), [side]);

  // on start: is a repo already open on the server?
  useEffect(() => {
    retry(api.health)
      .then((h) => { if (h.repo) { setRepoRoot(h.repo); setRepo(h.repo.split(/[\\/]/).pop()!.replace("__", "/")); } })
      .catch((e) => setError({ message: e.message }))
      .finally(() => setChecking(false));
  }, []);

  // the full list of files and connections (feeds the file tree and the Connections view)
  const loadGraph = useCallback(() => {
    setError(null);
    retry(api.graph)
      .then(setGraph)
      .catch((e) => setError({ message: e.message, retry: loadGraph }));
  }, []);
  useEffect(() => {
    if (repo) loadGraph();
  }, [repo, loadGraph]);

  // is an AI model connected?
  useEffect(() => {
    if (repo) api.ai().then(setAi).catch(() => setAi({ configured: false, model: "", provider: "" }));
  }, [repo]);

  // git: branch, ahead/behind, changed files. Checked now and every 15 seconds while a repo is open.
  const loadGit = useCallback(() => {
    api.git().then(setGit).catch(() => setGit({ is_repo: false }));
  }, []);
  useEffect(() => {
    if (!repo) return;
    loadGit();
    const t = setInterval(loadGit, 15000);
    return () => clearInterval(t);
  }, [repo, loadGit]);

  // the current folder level
  const loadFolder = useCallback((path: string) => {
    setFolderData(null);
    retry(() => api.folder(path))
      .then((d) => { setFolderData(d); setError(null); })
      .catch((e) => setError({ message: e.message, retry: () => loadFolder(path) }));
  }, []);
  useEffect(() => {
    if (repo) loadFolder(folder);
  }, [repo, folder, loadFolder]);

  const openRepo = async (source: string) => {
    const res = await api.open(source);
    setFolder("");
    setGraph(null);
    setFiles([]);
    setActive("");
    setTerminalOn(false);
    setTurns([]);
    setPath(null);
    setFocusId(null);
    setView("folder");
    setGit(null);
    setRepoRoot(res.root);
    setRepo(res.name.replace("__", "/"));
  };

  // open a file in its own tab (or switch to it if it's already open)
  const filesRef = useRef(files);
  filesRef.current = files;
  const showFile = useCallback((path: string, lines?: { start: number; end: number }) => {
    setActive(path);
    const reveal = lines ? { ...lines, nonce: Date.now() } : undefined;
    if (filesRef.current.some((f) => f.path === path)) {
      if (reveal) setFiles((fs) => fs.map((f) => (f.path === path ? { ...f, reveal } : f)));
      return;
    }
    setFiles((fs) => [...fs, { path, text: null, saved: null, reveal }]);
    retry(() => api.file(path))
      .then((f) => setFiles((cur) => cur.map((x) => (x.path === path ? { ...x, text: f.text, saved: f.text } : x))))
      .catch((e) => {
        setFiles((cur) => cur.filter((x) => x.path !== path));
        setError({ message: `Couldn't open ${path}: ${e.message}` });
      });
  }, []);

  const closeFile = (path: string) => {
    const f = files.find((x) => x.path === path);
    if (f && f.text !== f.saved && !window.confirm(`${path} has unsaved changes. Close it anyway?`)) return;
    const rest = files.filter((x) => x.path !== path);
    setFiles(rest);
    if (active === path) setActive(rest.at(-1)?.path ?? (terminalOn ? "terminal" : ""));
  };

  const saveFile = async (path: string) => {
    const f = files.find((x) => x.path === path);
    if (!f || f.text === null) return;
    const text = f.text;
    setFiles((cur) => cur.map((x) => (x.path === path ? { ...x, saving: true } : x)));
    try {
      await api.save(path, text);
      setFiles((cur) => cur.map((x) => (x.path === path ? { ...x, saved: text, saving: false } : x)));
      // the map is rebuilt on the server after a save: refresh what we show
      api.graph().then(setGraph).catch(() => {});
      api.folder(folder).then(setFolderData).catch(() => {});
      loadGit();
    } catch (e) {
      setFiles((cur) => cur.map((x) => (x.path === path ? { ...x, saving: false } : x)));
      setError({ message: `Couldn't save ${path}: ${(e as Error).message}`, retry: () => saveFile(path) });
    }
  };

  // Terminal button: open it, bring it to the front, or (if it's already in front) close it
  const toggleTerminal = useCallback(() => {
    if (!terminalOn) { setTerminalOn(true); setActive("terminal"); }
    else if (active !== "terminal") setActive("terminal");
    else { setTerminalOn(false); setActive(files.at(-1)?.path ?? ""); }
  }, [terminalOn, active, files]);

  // Ctrl + ` opens and closes the terminal, like VS Code
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "`") { e.preventDefault(); toggleTerminal(); }
      if (e.ctrlKey && e.shiftKey) {
        const k = e.key.toLowerCase();
        const p = k === "e" ? "files" : k === "f" ? "search" : k === "g" ? "git" : null;
        if (p) { e.preventDefault(); setSide((cur) => (cur === p ? null : p)); }
      }
      // Esc leaves the selected step (unless you're typing somewhere or a menu/card handles it)
      if (e.key === "Escape" && !(e.target as HTMLElement).closest?.("input, textarea, .monaco-editor, .xterm, [role=dialog], .menubar")) {
        leaveStepRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleTerminal]);

  // warn before closing the window with unsaved work
  useEffect(() => {
    const dirty = files.some((f) => f.text !== f.saved);
    const onUnload = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [files]);

  const showFolder = useCallback((path: string) => {
    setView("folder");
    setFolder(path);
    setFocusId(null);
  }, []);

  // file picked in the tree: open it, and move the map to its folder with the file highlighted
  const pickFile = useCallback((path: string) => {
    showFile(path);
    if (view === "folder") setFolder(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    setFocusId(path);
  }, [showFile, view]);

  // re-read the whole repo (after a pull, a branch switch, or edits made outside RepoBuddy) and redraw
  const sync = async () => {
    if (!repoRoot || syncing) return;
    setSyncing(true);
    try {
      await api.open(repoRoot);
      const [g, f] = await Promise.all([api.graph(), api.folder(folder)]);
      setGraph(g);
      setFolderData(f);
      loadGit();
    } catch (e) {
      setError({ message: `Couldn't update the map: ${(e as Error).message}`, retry: sync });
    } finally {
      setSyncing(false);
    }
  };

  // Go Live: start the project in the terminal with its usual command
  const goLive = async () => {
    try {
      const r = await api.run();
      if (!r.command) {
        setError({ message: "Couldn't tell how to start this project. Type its start command in the terminal." });
        setTerminalOn(true);
        setActive("terminal");
        return;
      }
      runInTerminal(r.needs_install ? `npm install; ${r.command}` : r.command);
    } catch (e) {
      setError({ message: (e as Error).message });
    }
  };

  // ---- actions from the Files panel
  const runInTerminal = (command: string) => {
    setTerminalOn(true);
    setActive("terminal");
    setRun({ command, nonce: Date.now() });
  };
  const absPath = (rel: string) => {
    if (!repoRoot) return rel;
    const sep = repoRoot.includes("\\") ? "\\" : "/";
    return rel ? repoRoot.replace(/[\\/]$/, "") + sep + rel.split("/").join(sep) : repoRoot;
  };
  const fileOp = async (op: "new_file" | "new_folder" | "rename" | "delete", path: string, newPath?: string) => {
    try {
      await api.fs(op, path, newPath);
    } catch (e) {
      setError({ message: (e as Error).message });
      return false;
    }
    // keep open tabs pointing at the right files
    const inside = (p: string) => p === path || p.startsWith(path + "/");
    if (op === "rename" && newPath) {
      setFiles((fs) => fs.map((f) => (inside(f.path) ? { ...f, path: newPath + f.path.slice(path.length) } : f)));
      if (inside(active)) setActive(newPath + active.slice(path.length));
    }
    if (op === "delete") {
      setFiles((fs) => fs.filter((f) => !inside(f.path)));
      if (inside(active)) setActive(terminalOn ? "terminal" : "");
    }
    api.graph().then(setGraph).catch(() => {});
    api.folder(folder).then(setFolderData).catch(() => {});
    loadGit();
    setNotice(op === "delete" ? `Deleted ${path}` : op === "rename" ? `Renamed to ${newPath}` : `Created ${path}`);
    return true;
  };
  const treeActions: TreeActions = {
    openFile: pickFile,
    showOnMap: (p, isFolder) => {
      if (isFolder) { showFolder(p); return; }
      setView("folder");
      setFolder(p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
      setFocusId(p);
    },
    askAbout: (p) => { setAskOpen(true); setDraft({ text: p ? `${p} ` : "", nonce: Date.now() }); },
    findIn: (p) => { setSearchScope(p); setSide("search"); },
    openTerminal: (p) => runInTerminal(`cd "${absPath(p)}"`),
    fileOp,
    refresh: () => { sync(); },
    notify: setNotice,
  };

  const toggleSide = (p: SidePanel) => { setSide((cur) => (cur === p ? null : p)); setPopup(null); };

  // ---- asking
  const ask = (question: string) => {
    const id = Date.now();
    setTurns((t) => [...t, { id, question, state: "thinking" }]);
    api.ask(question, active && active !== "terminal" ? active : null)
      .then((r) => {
        const meta = r.seconds !== undefined ? `Answered in ${r.seconds} s, ${r.tool_calls} look${r.tool_calls === 1 ? "" : "s"} at the code` : undefined;
        setTurns((t) => t.map((x) => (x.id === id ? { ...x, state: "done", answer: r.answer, steps: r.steps, meta } : x)));
        if (r.steps.length) setPath({ turn: id, step: null });
      })
      .catch((e) => setTurns((t) => t.map((x) => (x.id === id ? { ...x, state: "error", error: e.message } : x))));
  };
  // back to all steps: the whole path stays on the map, the camera zooms back out
  // back to all steps: the map goes to the level where the whole path is visible and zooms out
  const leaveStep = () => {
    const steps = turns.find((t) => t.id === path?.turn)?.steps?.filter((s) => s.verified) ?? [];
    setPath((p) => (p ? { ...p, step: null } : p));
    setFocusId(null);
    if (view === "folder" && steps.length) {
      // the deepest folder that contains every step's file
      const dirs = steps.map((s) => s.file.split("/").slice(0, -1));
      const common: string[] = [];
      for (let i = 0; dirs.every((d) => d[i] !== undefined && d[i] === dirs[0][i]); i++) common.push(dirs[0][i]);
      setFolder(common.join("/"));
    }
  };
  const leaveStepRef = useRef(leaveStep);
  leaveStepRef.current = leaveStep;
  // take the answer path off the map entirely
  const hidePath = () => { setPath(null); setFocusId(null); };

  const openStep = (turnId: number, i: number) => {
    const s = turns.find((t) => t.id === turnId)?.steps?.[i];
    if (!s) return;
    setPath({ turn: turnId, step: i });
    if (s.verified) showFile(s.file, { start: s.start, end: s.end });
    if (view === "folder") {
      // go straight to the step's file, wherever the map is right now
      setFolder(s.file.includes("/") ? s.file.slice(0, s.file.lastIndexOf("/")) : "");
      setFocusId(s.file);
    } else setFocusId(nodeFor(s.file));
  };

  // what the hover card says about a file: its own description, what it defines, routes, how much it's used
  const fileInfo = (f: { id: string; loc: number; in_degree?: number; entry?: boolean; blurb?: string | null; summary?: string | null; defines?: string[]; routes?: string[] }) => {
    const lines = [f.id];
    const about = f.summary || f.blurb;
    if (about) lines.push(about);
    if (f.routes?.length) lines.push(`Handles ${f.routes.join(", ")}`);
    if (f.defines?.length) lines.push(`Defines ${f.defines.join(", ")}`);
    lines.push(`${plural(f.loc, "line")}${f.in_degree ? `, used by ${plural(f.in_degree, "file")}` : ", not imported by other files"}`);
    if (f.entry) lines.push("Entry point: where the app starts");
    return lines;
  };

  const mapNodes: MapNodeInput[] = useMemo(() => {
    if (view === "graph") {
      return (graph?.nodes ?? []).map((n) => ({
        id: n.id,
        label: n.id.split("/").pop()!,
        type: "file",
        group: n.id.includes("/") ? n.id.split("/")[0] : "(root)",
        size: n.loc,
        weight: n.rank,
        info: fileInfo(n),
      }));
    }
    return (folderData?.nodes ?? []).map((n) => ({
      id: n.id,
      label: n.name,
      type: n.type,
      group: n.type === "folder" ? n.id : "file",
      size: n.loc,
      weight: n.rank,
      info:
        n.type === "folder"
          ? [`${n.name}/`, `${plural(n.files ?? 0, "file")}, ${plural(n.loc, "line")}`, ...(n.key_files?.length ? [`Main files: ${n.key_files.join(", ")}`] : []), "Click to open"]
          : fileInfo(n),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, graph, folderData]);

  // which node on the current map stands for a file: the file itself, or the folder it's inside
  function nodeFor(file: string): string | null {
    const ns = view === "graph" ? graph?.nodes ?? [] : folderData?.nodes ?? [];
    return ns.find((n) => n.id === file)?.id ?? ns.find((n) => file.startsWith(n.id + "/"))?.id ?? null;
  }
  const pathTurn = turns.find((t) => t.id === path?.turn);
  const course = useMemo(
    // one entry per step, in order ("" where the step isn't on this map), so numbers match the Ask panel
    () => (pathTurn?.steps ?? []).map((s) => (s.verified ? nodeFor(s.file) ?? "" : "")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pathTurn, view, graph, folderData],
  );

  const mapEdges = view === "graph" ? graph?.edges ?? [] : folderData?.edges ?? [];
  const ready = view === "graph" ? graph !== null : folderData !== null;

  if (checking) return null;
  if (!repo) return <OpenScreen onOpen={openRepo} />;

  const panelOpen = files.length > 0 || terminalOn;
  const crumbs = ["", ...folder.split("/").filter(Boolean).map((_, i, a) => a.slice(0, i + 1).join("/"))];

  const activeFile = files.find((f) => f.path === active);
  const menus: Menu[] = [
    {
      label: "File",
      items: [
        { label: "Open repository…", run: () => setRepo(null) },
        "divider",
        { label: "Save", keys: "Ctrl+S", disabled: !activeFile || activeFile.text === activeFile.saved, run: () => activeFile && saveFile(activeFile.path) },
        { label: "Close tab", disabled: !activeFile, run: () => activeFile && closeFile(activeFile.path) },
        "divider",
        { label: "Update map from disk", run: sync },
      ],
    },
    {
      label: "View",
      items: [
        { label: "Files", keys: "Ctrl+Shift+E", checked: side === "files", run: () => toggleSide("files") },
        { label: "Search", keys: "Ctrl+Shift+F", checked: side === "search", run: () => toggleSide("search") },
        { label: "Branches", keys: "Ctrl+Shift+G", checked: side === "git", run: () => toggleSide("git") },
        { label: "Ask the repo", checked: askOpen, run: () => setAskOpen(!askOpen) },
        "divider",
        { label: "Folders map", checked: view === "folder", run: () => setView("folder") },
        { label: "Connections map", checked: view === "graph", run: () => setView("graph") },
        { label: "3D", checked: dim === "3d", run: () => setDim("3d") },
        { label: "2D", checked: dim === "2d", run: () => setDim("2d") },
        "divider",
        { label: theme === "light" ? "Dark theme" : "Light theme", run: () => setTheme(theme === "light" ? "dark" : "light") },
      ],
    },
    {
      label: "Terminal",
      items: [
        { label: terminalOn ? "Show terminal" : "New terminal", keys: "Ctrl+`", run: () => { setTerminalOn(true); setActive("terminal"); } },
        { label: "Go Live", run: goLive },
      ],
    },
    {
      label: "Help",
      items: [
        { label: "Keyboard shortcuts", run: () => setPopup("settings") },
        { label: "Account and AI model", run: () => setPopup("account") },
      ],
    },
  ];

  const mapLeft = side ? RAIL + SIDE_W + 12 : RAIL;
  const askRight = askOpen ? ASK_W + 32 : 16;

  return (
    <>
      <header className="bar">
        <span className="wordmark">RepoBuddy</span>
        <MenuBar menus={menus} />
        <span className="repo-pill" title={repoRoot ?? undefined}>
          <b>{repo}</b>
          {git?.is_repo && <span>{git.branch}</span>}
        </span>
        <span className="spacer" />
        <div className="segmented" role="group" aria-label="View">
          <button aria-pressed={view === "folder"} onClick={() => setView("folder")}>Folders</button>
          <button aria-pressed={view === "graph"} onClick={() => setView("graph")}>Connections</button>
        </div>
        <div className="segmented" role="group" aria-label="Map style">
          <button aria-pressed={dim === "3d"} onClick={() => setDim("3d")}>3D</button>
          <button aria-pressed={dim === "2d"} onClick={() => setDim("2d")}>2D</button>
        </div>
        <button
          className="icon-btn"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
          title={theme === "light" ? "Dark theme" : "Light theme"}
        >
          {theme === "light" ? <MoonIcon /> : <SunIcon />}
        </button>
        <button className="pill-btn" aria-pressed={terminalOn} onClick={toggleTerminal} title="Ctrl + `">Terminal</button>
      </header>

      <Rail
        side={side}
        askOpen={askOpen}
        popup={popup}
        changes={git?.changes?.length ?? 0}
        onSide={toggleSide}
        onAsk={() => setAskOpen(!askOpen)}
        onPopup={(p) => setPopup((cur) => (cur === p ? null : p))}
      />

      <div className="map-area" style={{ left: mapLeft, bottom: panelOpen ? panelHeight + BOTTOM + 8 : BOTTOM, right: askOpen ? ASK_W + 16 : 0 }}>
        {view === "folder" && (
          <nav className="crumbs" aria-label="Folder path">
            {crumbs.map((c, i) => (
              <span key={c} style={{ display: "contents" }}>
                {i > 0 && <span className="sep">/</span>}
                <button aria-current={c === folder ? "page" : undefined} onClick={() => setFolder(c)}>
                  {c === "" ? repo.split("/").pop() : c.split("/").pop()}
                </button>
              </span>
            ))}
          </nav>
        )}
        {ready ? (
          <ForceMap
            course={course}
            focusId={focusId}
            mode={view}
            dim={dim}
            nodes={mapNodes}
            edges={mapEdges}
            theme={theme}
            onOpenFolder={showFolder}
            onOpenFile={showFile}
          />
        ) : (
          <p className="status">Drawing the map…</p>
        )}
        {path && path.step !== null && (
          <button className="sheet map-back" onClick={leaveStep} title="Esc">
            ← Back to all steps
          </button>
        )}
        <div className="legend">
          {view === "folder" && <span><i className="dot" />folder</span>}
          <span><i className="dot small" />file</span>
          <span><i className="flow" />import, dots show direction</span>
          <span><i className="route" />API call (inferred)</span>
          {course.some(Boolean) && (
            <span className="legend-answer">
              <i className="course-line" />your answer
              <button onClick={hidePath} title="Take the answer path off the map" aria-label="Take the answer path off the map">×</button>
            </span>
          )}
        </div>
        <span className="map-hint">{dim === "3d" ? "Drag to rotate, scroll to zoom, click to open" : "Scroll to zoom, drag to move, click to open"}</span>
      </div>

      {side === "files" && (
        graph ? (
          <FileTree repo={repo} root={repoRoot} files={graph.nodes.map((n) => n.id)} current={active} actions={treeActions} />
        ) : (
          <nav className="sheet side" aria-label="Files"><PanelHead title="Files" /><p className="side-meta">Loading files…</p></nav>
        )
      )}
      {side === "search" && (
        <SearchPanel
          scope={searchScope}
          onClearScope={() => setSearchScope("")}
          onOpen={(file, line) => { showFile(file, { start: line, end: line }); setFocusId(nodeFor(file)); }}
        />
      )}
      {side === "git" && <GitPanel git={git} onOpen={pickFile} onRefresh={loadGit} />}

      {panelOpen && (
        <BottomPanel
          files={files}
          active={active}
          terminalOn={terminalOn}
          theme={theme}
          height={panelHeight}
          left={mapLeft}
          right={askRight}
          onSelect={setActive}
          onCloseFile={closeFile}
          onCloseTerminal={() => { setTerminalOn(false); setActive(files.at(-1)?.path ?? ""); }}
          onChange={(path, text) => setFiles((cur) => cur.map((x) => (x.path === path ? { ...x, text } : x)))}
          onSave={saveFile}
          onResize={setPanelHeight}
          run={run}
        />
      )}
      {askOpen && (
        <AskPanel
          ai={ai}
          turns={turns}
          activeTurn={path?.turn ?? null}
          activeStep={path?.step ?? null}
          focusFile={active && active !== "terminal" ? active : null}
          onAsk={ask}
          onStep={openStep}
          onShowPath={(id) => { setPath({ turn: id, step: null }); setFocusId(null); }}
          onLeaveStep={leaveStep}
          draft={draft}
          onModelChange={setAi}
        />
      )}

      {popup === "account" && <AccountCard git={git} ai={ai} onClose={() => setPopup(null)} />}
      {popup === "settings" && (
        <SettingsCard theme={theme} dim={dim} view={view} onTheme={setTheme} onDim={setDim} onView={setView} onClose={() => setPopup(null)} />
      )}

      <StatusBar
        git={git}
        syncing={syncing}
        files={graph?.nodes.length ?? 0}
        ai={ai}
        onBranch={() => toggleSide("git")}
        onSync={sync}
        onGoLive={goLive}
        onAi={() => setPopup("account")}
      />

      {notice && <div className="notice" role="status">{notice}</div>}
      {error && (
        <div className="toast" role="alert">
          <span>{error.message}</span>
          {error.retry && <button onClick={error.retry}>Try again</button>}
          <button onClick={() => setError(null)} aria-label="Dismiss">Dismiss</button>
        </div>
      )}
    </>
  );
}
