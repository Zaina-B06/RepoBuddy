// The panels that open from the rail (besides Files): Search, and Branches & changes.
// Plus the two small cards for Account and Settings.
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { AiStatus, GitStatus, SearchResult } from "../api";
import { CloseIcon } from "./Icons";

export function PanelHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="panel-head">
      <h2>{title}</h2>
      {children}
    </header>
  );
}

// ---------------------------------------------------------------- search

export function SearchPanel({ onOpen, scope, onClearScope }: { onOpen: (file: string, line: number) => void; scope: string; onClearScope: () => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    setBusy(true);
    const t = setTimeout(() => {
      api.search(q, scope)
        .then((r) => { setRes(r); setErr(null); })
        .catch((e) => setErr(e.message))
        .finally(() => setBusy(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q, scope]);

  const groups = useMemo(() => {
    const m = new Map<string, SearchResult["hits"]>();
    for (const h of res?.hits ?? []) m.set(h.file, [...(m.get(h.file) ?? []), h]);
    return [...m.entries()];
  }, [res]);

  const mark = (text: string) => {
    const i = text.toLowerCase().indexOf(q.trim().toLowerCase());
    if (i < 0) return text;
    const n = q.trim().length;
    return <>{text.slice(0, i)}<mark>{text.slice(i, i + n)}</mark>{text.slice(i + n)}</>;
  };

  return (
    <nav className="sheet side" aria-label="Search">
      <PanelHead title="Search" />
      <div className="side-field">
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={scope ? `Search in ${scope}/` : "Search the code"} aria-label="Search the code" />
      </div>
      {scope && (
        <div className="scope-chip">
          In <b>{scope}/</b>
          <button onClick={onClearScope} aria-label="Search the whole repo"><CloseIcon /></button>
        </div>
      )}
      <p className="side-meta">
        {err ? <span className="error">{err}</span>
          : busy ? "Searching…"
          : res ? `${res.hits.length}${res.truncated ? "+" : ""} results in ${groups.length} file${groups.length === 1 ? "" : "s"}`
          : "Type at least two letters."}
      </p>
      <div className="side-list">
        {groups.map(([file, hits]) => (
          <div key={file} className="hit-group">
            <button className="hit-file" onClick={() => onOpen(file, hits[0].line)} title={file}>
              {file.split("/").pop()}<span>{file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ""}</span>
            </button>
            {hits.slice(0, 8).map((h) => (
              <button key={h.line} className="hit" onClick={() => onOpen(file, h.line)}>
                <span className="ln">{h.line}</span>
                <span className="txt">{mark(h.text)}</span>
              </button>
            ))}
            {hits.length > 8 && <p className="side-meta" style={{ paddingLeft: 40 }}>and {hits.length - 8} more</p>}
          </div>
        ))}
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------- branches and changes

export function GitPanel({ git, onOpen, onRefresh }: { git: GitStatus | null; onOpen: (file: string) => void; onRefresh: () => void }) {
  return (
    <nav className="sheet side" aria-label="Branches and changes">
      <PanelHead title="Branches">
        <button className="head-btn" onClick={onRefresh}>Refresh</button>
      </PanelHead>
      <div className="side-list">
        {!git ? (
          <p className="side-meta">Reading git…</p>
        ) : !git.is_repo ? (
          <p className="side-meta">This folder isn't a git repository, so there are no branches to show.</p>
        ) : (
          <>
            <div className="git-current">
              <span className="git-label">On branch</span>
              <b>{git.branch}</b>
              <span className="side-meta" style={{ padding: 0 }}>
                {git.upstream ? `Tracking ${git.upstream}` : "Not linked to a remote branch"}
                {git.upstream && (git.ahead || git.behind)
                  ? `, ${git.ahead ? `${git.ahead} to push` : ""}${git.ahead && git.behind ? ", " : ""}${git.behind ? `${git.behind} to pull` : ""}`
                  : git.upstream ? ", up to date" : ""}
              </span>
            </div>
            <h3 className="side-sub">Changed files <span>{git.changes?.length ?? 0}</span></h3>
            {git.changes?.length ? (
              git.changes.map((c) => (
                <button key={c.path} className="tree-row change" onClick={() => onOpen(c.path)} title={c.path}>
                  <span className={"st st-" + c.status}>{c.status[0].toUpperCase()}</span>
                  <span className="nm">{c.path.split("/").pop()}</span>
                  <span className="count">{c.path.includes("/") ? c.path.slice(0, c.path.lastIndexOf("/")) : ""}</span>
                </button>
              ))
            ) : (
              <p className="side-meta">No changes since the last commit.</p>
            )}
            <h3 className="side-sub">Local branches <span>{git.branches?.length ?? 0}</span></h3>
            {git.branches?.map((b) => (
              <div key={b} className={"tree-row branch" + (b === git.branch ? " here" : "")}>
                <span className="dotmark" />{b}{b === git.branch && <span className="count">current</span>}
              </div>
            ))}
          </>
        )}
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------- account and settings cards

function Card({ title, onClose, className, children }: { title: string; onClose: () => void; className: string; children: React.ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className={"sheet card " + className} role="dialog" aria-label={title}>
      <PanelHead title={title}>
        <button className="head-x" onClick={onClose} aria-label="Close"><CloseIcon /></button>
      </PanelHead>
      <div className="card-body">{children}</div>
    </div>
  );
}

export function AccountCard({ git, ai, onClose }: { git: GitStatus | null; ai: AiStatus | null; onClose: () => void }) {
  const name = git?.user?.name, email = git?.user?.email;
  return (
    <Card title="Account" onClose={onClose} className="account-card">
      <div className="who">
        <span className="avatar">{(name || "?").slice(0, 1).toUpperCase()}</span>
        <div>
          <b>{name || "No git name set"}</b>
          <span>{email || "Set one with: git config --global user.email you@example.com"}</span>
        </div>
      </div>
      <dl>
        <dt>Commits as</dt><dd>{name ? `${name} <${email}>` : "Not set"}</dd>
        <dt>AI model</dt><dd>{ai?.configured ? `${ai.model} (${ai.provider})` : "Not connected. Add a key in backend/.env"}</dd>
        <dt>Where code goes</dt><dd>Your repo stays on this computer. Only the lines the agent reads are sent to the AI model.</dd>
      </dl>
    </Card>
  );
}

type SettingsProps = {
  theme: "light" | "dark"; dim: "3d" | "2d"; view: "folder" | "graph";
  onTheme: (t: "light" | "dark") => void; onDim: (d: "3d" | "2d") => void; onView: (v: "folder" | "graph") => void;
  onClose: () => void;
};

export function SettingsCard(p: SettingsProps) {
  const row = <T extends string>(label: string, value: T, options: [T, string][], set: (v: T) => void) => (
    <div className="set-row">
      <span>{label}</span>
      <div className="segmented" role="group" aria-label={label}>
        {options.map(([v, l]) => <button key={v} aria-pressed={value === v} onClick={() => set(v)}>{l}</button>)}
      </div>
    </div>
  );
  return (
    <Card title="Settings" onClose={p.onClose} className="settings-card">
      {row("Theme", p.theme, [["light", "Light"], ["dark", "Dark"]], p.onTheme)}
      {row("Map style", p.dim, [["3d", "3D"], ["2d", "2D"]], p.onDim)}
      {row("Map shows", p.view, [["folder", "Folders"], ["graph", "Connections"]], p.onView)}
      <h3 className="side-sub" style={{ padding: "14px 0 6px" }}>Keyboard shortcuts</h3>
      <dl className="keys">
        <dt>Save file</dt><dd><kbd>Ctrl</kbd><kbd>S</kbd></dd>
        <dt>Terminal</dt><dd><kbd>Ctrl</kbd><kbd>`</kbd></dd>
        <dt>Files</dt><dd><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>E</kbd></dd>
        <dt>Search</dt><dd><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>F</kbd></dd>
        <dt>Branches</dt><dd><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>G</kbd></dd>
        <dt>Leave a step</dt><dd><kbd>Esc</kbd></dd>
      </dl>
    </Card>
  );
}
