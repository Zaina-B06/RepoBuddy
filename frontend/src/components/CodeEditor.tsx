// The code editor: Monaco, the same editor VS Code uses.
// Find (Ctrl+F), replace (Ctrl+H), multi-cursor and the rest come built in. Ctrl+S saves.
import { useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import { monaco } from "../monaco-setup";

const LANGS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", json: "json", css: "css", scss: "scss", less: "less", html: "html", md: "markdown", mdx: "markdown",
  yml: "yaml", yaml: "yaml", sh: "shell", ps1: "powershell", sql: "sql", go: "go", rs: "rust", java: "java", toml: "ini",
};

type Props = {
  path: string;
  text: string;
  theme: "light" | "dark";
  onChange: (text: string) => void;
  onSave: () => void;
  reveal?: { start: number; end: number; nonce: number }; // lines to jump to and highlight
};

export function CodeEditor({ path, text, theme, onChange, onSave, reveal }: Props) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const marks = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);

  const show = () => {
    if (!ed.current || !reveal) return;
    // put the first highlighted line near the top (below the sticky function header), so nothing is cut off
    const e = ed.current;
    const lineH = e.getOption(monaco.editor.EditorOption.lineHeight);
    e.setScrollTop(Math.max(0, e.getTopForLineNumber(reveal.start) - lineH * 3), monaco.editor.ScrollType.Smooth);
    e.setPosition({ lineNumber: reveal.start, column: 1 });
    marks.current?.clear();
    marks.current = ed.current.createDecorationsCollection([
      { range: new monaco.Range(reveal.start, 1, reveal.end, 1), options: { isWholeLine: true, className: "rb-step-lines", linesDecorationsClassName: "rb-step-gutter" } },
    ]);
  };
  useEffect(show, [reveal?.nonce, path]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Editor
      path={path} // one model per file, so switching tabs keeps each file's undo history and scroll
      defaultValue={text}
      language={LANGS[ext] ?? "plaintext"}
      theme={theme === "light" ? "rb-light" : "rb-dark"}
      onChange={(v) => onChange(v ?? "")}
      onMount={(editor) => {
        ed.current = editor;
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave());
        show();
      }}
      options={{
        fontFamily: '"JetBrains Mono Variable", monospace',
        fontSize: 13,
        lineHeight: 20,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        automaticLayout: true,
        padding: { top: 8 },
        renderLineHighlight: "all",
      }}
    />
  );
}
