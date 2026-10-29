// The Files panel: the repo as a folder tree, like an IDE's explorer.
// Right-click (or the ⋯ button) any row for actions: show on map, ask about it, open in terminal,
// copy its path, new file/folder, rename, delete.
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PanelHead } from "./SidePanels";
import { CollapseIcon, NewFileIcon, NewFolderIcon, RefreshIcon } from "./Icons";

type Dir = { name: string; path: string; dirs: Map<string, Dir>; files: string[]; count: number };

function buildTree(paths: string[], extraDirs: string[]): Dir {
  const root: Dir = { name: "", path: "", dirs: new Map(), files: [], count: 0 };
  const dirOf = (parts: string[], counting: boolean) => {
    let d = root;
    if (counting) d.count++;
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join("/");
      if (!d.dirs.has(parts[i])) d.dirs.set(parts[i], { name: parts[i], path, dirs: new Map(), files: [], count: 0 });
      d = d.dirs.get(parts[i])!;
      if (counting) d.count++;
    }
    return d;
  };
  for (const p of [...paths].sort()) {
    const parts = p.split("/");
    dirOf(parts.slice(0, -1), true).files.push(p);
  }
  for (const d of extraDirs) dirOf(d.split("/"), false); // folders made here that have no files yet
  return root;
}

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export type TreeActions = {
  openFile: (path: string) => void;
  showOnMap: (path: string, isFolder: boolean) => void;
  askAbout: (path: string) => void;
  findIn: (folder: string) => void;
  openTerminal: (folder: string) => void;
  fileOp: (op: "new_file" | "new_folder" | "rename" | "delete", path: string, newPath?: string) => Promise<boolean>;
  refresh: () => void;
  notify: (message: string) => void;
};

type Props = { repo: string; root: string | null; files: string[]; current: string | null; actions: TreeActions };

type Menu = { x: number; y: number; path: string; folder: boolean };
type Edit = { kind: "new_file" | "new_folder"; parent: string } | { kind: "rename"; path: string; folder: boolean };

export function FileTree({ repo, root, files, current, actions }: Props) {
  const [extraDirs, setExtraDirs] = useState<string[]>([]);
  const tree = useMemo(() => buildTree(files, extraDirs), [files, extraDirs]);
  const [open, setOpen] = useState<Set<string>>(new Set([""]));
  const [menu, setMenu] = useState<Menu | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  // when a file is opened from elsewhere (map, search, an answer), open its folders and scroll to it
  useEffect(() => {
    if (!current || current === "terminal") return;
    setSelected(current);
    setOpen((s) => {
      const next = new Set(s);
      const parts = current.split("/");
      for (let i = 0; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
    requestAnimationFrame(() => list.current?.querySelector(`[data-path="${CSS.escape(current)}"]`)?.scrollIntoView({ block: "nearest" }));
  }, [current]);

  // close the menu on any outside click or Esc
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", esc); window.removeEventListener("blur", close); };
  }, [menu]);

  const toggle = (path: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); actions.notify(`Copied ${what}`); }
    catch { actions.notify("Couldn't reach the clipboard"); }
  };
  const absolute = (rel: string) => {
    if (!root) return rel;
    const sep = root.includes("\\") ? "\\" : "/";
    return rel ? root.replace(/[\\/]$/, "") + sep + rel.split("/").join(sep) : root;
  };

  const startNew = (kind: "new_file" | "new_folder", parent: string) => {
    setOpen((s) => new Set(s).add(parent));
    setEdit({ kind, parent });
  };
  const commit = async (value: string) => {
    const e = edit;
    setEdit(null);
    const name = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!e || !name) return;
    if (e.kind === "rename") {
      const to = parentOf(e.path) ? `${parentOf(e.path)}/${name}` : name;
      if (to !== e.path) await actions.fileOp("rename", e.path, to);
      return;
    }
    const path = e.parent ? `${e.parent}/${name}` : name;
    if (await actions.fileOp(e.kind, path)) {
      if (e.kind === "new_folder") { setExtraDirs((d) => [...d, path]); setOpen((s) => new Set(s).add(path)); }
      else { setSelected(path); actions.openFile(path); }
    }
  };
  const remove = async (path: string, folder: boolean) => {
    if (!window.confirm(`Delete ${folder ? "the folder " : ""}${path}${folder ? " and everything in it" : ""}? This can't be undone here.`)) return;
    if (await actions.fileOp("delete", path)) setExtraDirs((d) => d.filter((x) => x !== path && !x.startsWith(path + "/")));
  };

  const openMenu = (e: React.MouseEvent, path: string, folder: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(path);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fromButton = e.type === "click";
    setMenu({ x: fromButton ? r.right - 8 : e.clientX, y: fromButton ? r.bottom : e.clientY, path, folder });
  };

  const input = (depth: number, initial: string, folder: boolean) => (
    <div className="tree-row editing" style={{ paddingLeft: 12 + depth * 14 }}>
      <span className="chev">{folder ? "▸" : ""}</span>
      <input
        autoFocus
        defaultValue={initial}
        aria-label={folder ? "Folder name" : "File name"}
        placeholder={folder ? "folder name" : "file name, e.g. utils.ts"}
        onFocus={(e) => { const dot = initial.lastIndexOf("."); e.currentTarget.setSelectionRange(0, dot > 0 && !folder ? dot : initial.length); }}
        onKeyDown={(e) => { if (e.key === "Enter") commit(e.currentTarget.value); if (e.key === "Escape") setEdit(null); }}
        onBlur={(e) => commit(e.currentTarget.value)}
      />
    </div>
  );

  const render = (d: Dir, depth: number): React.ReactNode[] => {
    const rows: React.ReactNode[] = [];
    if (edit && edit.kind !== "rename" && edit.parent === d.path) rows.push(<div key="new">{input(depth, "", edit.kind === "new_folder")}</div>);
    for (const sub of [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const isOpen = open.has(sub.path);
      if (edit?.kind === "rename" && edit.path === sub.path) { rows.push(<div key={"r:" + sub.path}>{input(depth, sub.name, true)}</div>); continue; }
      rows.push(
        <div
          key={"d:" + sub.path}
          className="tree-row"
          role="treeitem"
          aria-expanded={isOpen}
          aria-selected={selected === sub.path}
          data-path={sub.path}
          style={{ paddingLeft: 12 + depth * 14 }}
          onClick={() => { setSelected(sub.path); toggle(sub.path); if (!isOpen) actions.showOnMap(sub.path, true); }}
          onContextMenu={(e) => openMenu(e, sub.path, true)}
          onKeyDown={(e) => { if (e.key === "F2") setEdit({ kind: "rename", path: sub.path, folder: true }); if (e.key === "Delete") remove(sub.path, true); }}
          tabIndex={0}
          title={sub.path}
        >
          <span className="chev">{isOpen ? "▾" : "▸"}</span>
          <span className="nm">{sub.name}</span>
          <span className="count">{sub.count || ""}</span>
          <button className="row-more" onClick={(e) => openMenu(e, sub.path, true)} aria-label={`Actions for ${sub.name}`}>⋯</button>
        </div>,
      );
      if (isOpen) rows.push(...render(sub, depth + 1));
    }
    for (const f of d.files) {
      if (edit?.kind === "rename" && edit.path === f) { rows.push(<div key={"r:" + f}>{input(depth, f.split("/").pop()!, false)}</div>); continue; }
      rows.push(
        <div
          key={"f:" + f}
          className={"tree-row file" + (current === f ? " open-file" : "")}
          role="treeitem"
          aria-selected={selected === f}
          data-path={f}
          style={{ paddingLeft: 12 + depth * 14 }}
          onClick={() => { setSelected(f); actions.openFile(f); }}
          onContextMenu={(e) => openMenu(e, f, false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") actions.openFile(f);
            if (e.key === "F2") setEdit({ kind: "rename", path: f, folder: false });
            if (e.key === "Delete") remove(f, false);
          }}
          tabIndex={0}
          title={f}
        >
          <span className="chev" />
          <span className="nm">{f.split("/").pop()}</span>
          <button className="row-more" onClick={(e) => openMenu(e, f, false)} aria-label={`Actions for ${f}`}>⋯</button>
        </div>,
      );
    }
    return rows;
  };

  const rootOpen = open.has("");
  const repoName = repo.split("/").pop() || repo;

  // the actions for the menu, built for the row that was clicked
  const items = (m: Menu): ({ label: string; keys?: string; danger?: boolean; run: () => void } | "divider")[] => {
    const isRoot = m.path === "";
    const folder = m.folder ? m.path : parentOf(m.path);
    const shown = isRoot ? repoName : m.path;
    return [
      ...(!m.folder ? [{ label: "Open", run: () => actions.openFile(m.path) }] : []),
      { label: "Show on map", run: () => actions.showOnMap(m.path, m.folder) },
      { label: "Add to question", run: () => actions.askAbout(isRoot ? "" : m.path) },
      "divider",
      ...(m.folder ? [
        { label: "New file…", run: () => startNew("new_file", m.path) },
        { label: "New folder…", run: () => startNew("new_folder", m.path) },
        { label: "Find in folder…", run: () => actions.findIn(m.path) },
      ] : []),
      { label: "Open in terminal", run: () => actions.openTerminal(folder) },
      "divider",
      { label: "Copy path", run: () => copy(absolute(m.path), `path of ${shown}`) },
      { label: "Copy relative path", run: () => copy(m.path || ".", `relative path of ${shown}`) },
      ...(!isRoot ? [
        "divider" as const,
        { label: "Rename…", keys: "F2", run: () => setEdit({ kind: "rename", path: m.path, folder: m.folder }) },
        { label: "Delete", keys: "Del", danger: true, run: () => remove(m.path, m.folder) },
      ] : []),
    ];
  };

  return (
    <nav className="sheet side" aria-label="Files">
      <PanelHead title="Files">
        <span className="head-tools">
          <button onClick={() => startNew("new_file", selectedFolder())} title="New file" aria-label="New file"><NewFileIcon /></button>
          <button onClick={() => startNew("new_folder", selectedFolder())} title="New folder" aria-label="New folder"><NewFolderIcon /></button>
          <button onClick={actions.refresh} title="Update from disk" aria-label="Update from disk"><RefreshIcon /></button>
          <button onClick={() => setOpen(new Set([""]))} title="Collapse all folders" aria-label="Collapse all folders"><CollapseIcon /></button>
        </span>
      </PanelHead>
      <div className="side-list" ref={list} role="tree">
        <div
          className="tree-row root-row"
          role="treeitem"
          aria-expanded={rootOpen}
          aria-selected={selected === ""}
          onClick={() => { setSelected(""); toggle(""); actions.showOnMap("", true); }}
          onContextMenu={(e) => openMenu(e, "", true)}
          tabIndex={0}
          title={root ?? repo}
        >
          <span className="chev">{rootOpen ? "▾" : "▸"}</span>
          <span className="nm">{repoName}</span>
          <span className="count">{files.length.toLocaleString()} files</span>
          <button className="row-more" onClick={(e) => openMenu(e, "", true)} aria-label="Actions for the repo">⋯</button>
        </div>
        {rootOpen && render(tree, 1)}
      </div>

      {menu && createPortal(
        <div
          className="sheet ctx-menu"
          role="menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 380) }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {items(menu).map((it, i) =>
            it === "divider" ? <hr key={i} /> : (
              <button key={it.label} role="menuitem" className={it.danger ? "danger" : ""} onClick={() => { setMenu(null); it.run(); }}>
                <span>{it.label}</span>
                {it.keys && <kbd>{it.keys}</kbd>}
              </button>
            ),
          )}
        </div>,
        document.body,
      )}
    </nav>
  );

  // the folder new files go into from the header buttons: the selected folder, or the selected file's folder
  function selectedFolder() {
    if (selected === null) return "";
    const isDir = selected === "" || !files.includes(selected);
    return isDir ? selected : parentOf(selected);
  }
}
