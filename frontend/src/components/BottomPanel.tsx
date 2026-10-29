// The bottom panel: one tab per open file, plus the Terminal tab. Drag its top edge to resize.
import { CodeEditor } from "./CodeEditor";
import { TerminalView } from "./TerminalView";

export type OpenFile = {
  path: string; text: string | null; saved: string | null; saving?: boolean;
  reveal?: { start: number; end: number; nonce: number };
};

type Props = {
  files: OpenFile[];
  active: string; // a file path, or "terminal"
  terminalOn: boolean;
  theme: "light" | "dark";
  height: number;
  left: number;
  right: number;
  onSelect: (tab: string) => void;
  onCloseFile: (path: string) => void;
  onCloseTerminal: () => void;
  onChange: (path: string, text: string) => void;
  onSave: (path: string) => void;
  onResize: (height: number) => void;
  run?: { command: string; nonce: number };
};

export function BottomPanel(p: Props) {
  const current = p.files.find((f) => f.path === p.active);

  const startDrag = (e: React.PointerEvent) => {
    const startY = e.clientY, startH = p.height;
    const move = (ev: PointerEvent) => p.onResize(Math.min(window.innerHeight - 160, Math.max(160, startH + startY - ev.clientY)));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section className="sheet bottom-panel" style={{ height: p.height, left: p.left, right: p.right }} aria-label="Editor and terminal">
      <div className="resize-handle" onPointerDown={startDrag} role="separator" aria-label="Resize panel" />
      <div className="sheet-tabs" role="tablist">
        {p.files.map((f) => {
          const dirty = f.text !== null && f.saved !== null && f.text !== f.saved;
          return (
            <div key={f.path} className="tab" role="tab" aria-selected={p.active === f.path} title={f.path}>
              <button className="tab-name" onClick={() => p.onSelect(f.path)}>
                {f.path.split("/").pop()}
                {dirty && <span className="dirty" aria-label="unsaved changes" />}
              </button>
              <button className="tab-x" onClick={() => p.onCloseFile(f.path)} aria-label={`Close ${f.path}`}>×</button>
            </div>
          );
        })}
        {p.terminalOn && (
          <div className="tab term-tab" role="tab" aria-selected={p.active === "terminal"}>
            <button className="tab-name" onClick={() => p.onSelect("terminal")}>Terminal</button>
            <button className="tab-x" onClick={p.onCloseTerminal} aria-label="Close terminal">×</button>
          </div>
        )}
        {current && current.text !== null && current.text !== current.saved && (
          <button className="save-btn" onClick={() => p.onSave(current.path)} disabled={current.saving}>
            {current.saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      <div className="panel-body">
        {current &&
          (current.text === null ? (
            <p className="status" style={{ position: "static", transform: "none", padding: 16 }}>Opening {current.path}…</p>
          ) : (
            <CodeEditor
              path={current.path}
              text={current.text}
              theme={p.theme}
              onChange={(t) => p.onChange(current.path, t)}
              onSave={() => p.onSave(current.path)}
              reveal={current.reveal}
            />
          ))}
        {p.terminalOn && <TerminalView theme={p.theme} visible={p.active === "terminal"} run={p.run} />}
      </div>
    </section>
  );
}
