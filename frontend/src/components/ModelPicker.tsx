// Pick which AI model answers questions: Muse, Claude, GPT, or anything else with a key in backend/.env.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { AiStatus, ModelCatalog } from "../api";

type Props = { ai: AiStatus | null; onChange: (ai: AiStatus) => void };

const short = (m: string) => m.split("/").pop() ?? m;

export function ModelPicker({ ai, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState<ModelCatalog | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [pos, setPos] = useState({ bottom: 0, left: 0 });
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    api.models().then(setCat).catch((e) => setErr(e.message));
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", esc); };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    // open upward from the question box, like the model menu in VS Code's chat
    setPos({ bottom: window.innerHeight - r.top + 8, left: Math.max(8, Math.min(r.left - 6, window.innerWidth - 308)) });
  }, [open]);

  const pick = async (provider: string, model: string) => {
    try {
      onChange(await api.setModel(provider, model));
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const q = filter.trim().toLowerCase();
  return (
    <>
      <button
        ref={btn}
        className={"model-btn" + (ai?.configured ? " on" : "")}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={ai?.configured ? `${ai.model} via ${ai.provider}. Click to change.` : "Choose a model"}
      >
        <i />
        <span>{ai?.configured ? short(ai.model) : "Choose model"}</span>
        <b aria-hidden="true">▾</b>
      </button>
      {open && createPortal(
        <div ref={box} className="sheet model-menu" style={{ bottom: pos.bottom, left: pos.left }} role="dialog" aria-label="Choose a model">
          <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a model" aria-label="Find a model" />
          <div className="model-list">
            {!cat && !err && <p className="model-note">Loading models…</p>}
            {err && <p className="model-note error">{err}</p>}
            {cat?.providers.map((p) => {
              const models = p.models.filter((m) => !q || m.toLowerCase().includes(q) || p.label.toLowerCase().includes(q));
              if (p.configured && q && !models.length) return null;
              return (
                <section key={p.id}>
                  {cat.providers.length > 1 && <h4>{p.label}</h4>}
                  {!p.configured ? (
                    <p className="model-note">Add <code>{p.env}=your-key</code> to <code>backend/.env</code> and restart the server.</p>
                  ) : models.length ? (
                    models.map((m) => {
                      const on = cat.current.provider === p.id && cat.current.model === m;
                      return (
                        <button key={m} className={on ? "on" : ""} onClick={() => pick(p.id, m)} title={m}>
                          <span className="tick">{on ? "✓" : ""}</span>
                          <span className="nm">{m}</span>
                        </button>
                      );
                    })
                  ) : (
                    <p className="model-note">{p.error ?? "No models found."}</p>
                  )}
                </section>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
