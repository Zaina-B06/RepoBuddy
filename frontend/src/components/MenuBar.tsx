// File / View / Terminal / Help menus in the top bar, like a desktop IDE.
import { useEffect, useRef, useState } from "react";

export type MenuItem = { label: string; keys?: string; checked?: boolean; disabled?: boolean; run: () => void } | "divider";
export type Menu = { label: string; items: MenuItem[] };

export function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const bar = useRef<HTMLDivElement>(null);

  // close when clicking anywhere else or pressing Esc
  useEffect(() => {
    if (open === null) return;
    const away = (e: PointerEvent) => { if (!bar.current?.contains(e.target as Node)) setOpen(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div className="menubar" ref={bar} role="menubar">
      {menus.map((m, i) => (
        <div key={m.label} className="menu">
          <button
            role="menuitem"
            aria-haspopup="true"
            aria-expanded={open === i}
            onClick={() => setOpen(open === i ? null : i)}
            onPointerEnter={() => open !== null && setOpen(i)}
          >
            {m.label}
          </button>
          {open === i && (
            <div className="sheet menu-list" role="menu">
              {m.items.map((it, j) =>
                it === "divider" ? (
                  <hr key={j} />
                ) : (
                  <button
                    key={it.label}
                    role="menuitemcheckbox"
                    aria-checked={it.checked ?? undefined}
                    disabled={it.disabled}
                    onClick={() => { setOpen(null); it.run(); }}
                  >
                    <span className="tick">{it.checked ? "✓" : ""}</span>
                    <span>{it.label}</span>
                    {it.keys && <kbd>{it.keys}</kbd>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
