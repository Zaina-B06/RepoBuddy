// The terminal: a real shell (PowerShell on Windows) running in the open repo, through the local server.
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const THEMES = {
  light: { background: "#F8FBFA", foreground: "#14263A", cursor: "#C2257A", selectionBackground: "#C2257A33", black: "#14263A", brightBlack: "#5B7080" },
  dark: { background: "#142430", foreground: "#DCE6EA", cursor: "#E2479A", selectionBackground: "#E2479A40", black: "#0E1A24", brightBlack: "#7F98A6" },
};

type Props = {
  theme: "light" | "dark";
  visible: boolean;
  run?: { command: string; nonce: number }; // a command to type in for you (used by Go Live)
};

export function TerminalView({ theme, visible, run }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const pending = useRef<string | null>(run?.command ?? null);

  useEffect(() => {
    const t = new Terminal({
      fontFamily: '"JetBrains Mono Variable", monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: THEMES[theme],
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(box.current!);
    term.current = t;
    fit.current = f;

    const ws = new WebSocket("ws://localhost:8000/api/terminal");
    const sendSize = () => {
      try { f.fit(); } catch { /* hidden */ }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
    };
    socket.current = ws;
    ws.onopen = () => {
      sendSize();
      // a command asked for before the shell was ready: type it once the prompt has appeared
      const cmd = pending.current;
      pending.current = null;
      if (cmd) setTimeout(() => ws.send(JSON.stringify({ type: "input", data: cmd + "\r" })), 700);
    };
    ws.onmessage = (e) => t.write(typeof e.data === "string" ? e.data : "");
    ws.onclose = () => t.write("\r\n\x1b[2m[terminal closed. Close and reopen the Terminal tab to start a new one]\x1b[0m\r\n");
    ws.onerror = () =>
      t.write("\r\n\x1b[31mThe terminal couldn't connect.\x1b[0m Check the server is running, then in the backend terminal run:\r\n" +
        "  python -m pip install websockets pywinpty\r\nand restart the server.\r\n");
    const input = t.onData((data) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "input", data })));

    // Copy and paste like Windows Terminal:
    //  Ctrl+C copies when text is selected (otherwise it stops the running command, as usual),
    //  Ctrl+Shift+C copies, Ctrl+V / Ctrl+Shift+V paste, right-click copies a selection or pastes.
    const copySelection = () => {
      const text = t.getSelection();
      if (!text) return false;
      navigator.clipboard.writeText(text).catch(() => {});
      t.clearSelection();
      return true;
    };
    const paste = () => navigator.clipboard.readText().then((text) => text && t.paste(text)).catch(() => {});
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey) return true;
      const k = e.key.toLowerCase();
      if (k === "c" && (e.shiftKey || t.hasSelection())) { e.preventDefault(); copySelection(); return false; }
      if (k === "v") { e.preventDefault(); paste(); return false; }
      return true;
    });
    const onRightClick = (e: MouseEvent) => {
      e.preventDefault();
      if (!copySelection()) paste();
    };
    box.current!.addEventListener("contextmenu", onRightClick);

    const ro = new ResizeObserver(sendSize);
    ro.observe(box.current!);
    const el = box.current!;
    return () => { ro.disconnect(); input.dispose(); el.removeEventListener("contextmenu", onRightClick); ws.close(); t.dispose(); };
    // theme is applied in the effect below; the terminal itself is created once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (term.current) term.current.options.theme = THEMES[theme];
  }, [theme]);

  useEffect(() => {
    if (!run) return;
    const ws = socket.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data: run.command + "\r" }));
    else pending.current = run.command;
  }, [run?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (visible) {
      try { fit.current?.fit(); } catch { /* ignore */ }
      term.current?.focus();
    }
  }, [visible]);

  return <div ref={box} className="terminal-box" style={{ display: visible ? "block" : "none" }} />;
}
