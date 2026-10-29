// Load the Monaco editor (the editor inside VS Code) from our own files instead of the internet,
// so RepoBuddy works offline and as a desktop app.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "typescript" || label === "javascript") return new TsWorker();
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html") return new HtmlWorker();
    return new EditorWorker();
  },
};

// We show one file at a time without the rest of its project, so "can't find module" errors
// would be everywhere. Keep syntax checking, skip the project-wide type checking.
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  defaults.setCompilerOptions({ jsx: monaco.typescript.JsxEmit.Preserve, allowJs: true, target: monaco.typescript.ScriptTarget.ESNext });
}

// Editor colours that match RepoBuddy's two themes.
monaco.editor.defineTheme("rb-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "8197A3", fontStyle: "italic" },
    { token: "keyword", foreground: "8B2F78" },
    { token: "string", foreground: "4F7A1F" },
    { token: "number", foreground: "B0761C" },
    { token: "type", foreground: "1F6C8F" },
  ],
  colors: {
    "editor.background": "#F8FBFA",
    "editor.lineHighlightBackground": "#EDF3F1",
    "editorLineNumber.foreground": "#9BB0B9",
    "editorLineNumber.activeForeground": "#14263A",
    "editor.selectionBackground": "#C2257A33",
    "editorCursor.foreground": "#C2257A",
  },
});
monaco.editor.defineTheme("rb-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "5F7A88", fontStyle: "italic" },
    { token: "keyword", foreground: "C792B8" },
    { token: "string", foreground: "B9C98A" },
    { token: "number", foreground: "E0B25A" },
    { token: "type", foreground: "8FC1D9" },
  ],
  colors: {
    "editor.background": "#142430",
    "editor.lineHighlightBackground": "#1A2E3C",
    "editorLineNumber.foreground": "#4E6878",
    "editorLineNumber.activeForeground": "#DCE6EA",
    "editor.selectionBackground": "#E2479A40",
    "editorCursor.foreground": "#E2479A",
  },
});

loader.config({ monaco });

export { monaco };
