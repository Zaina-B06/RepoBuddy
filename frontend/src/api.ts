// Talks to the local Python server (backend/server.py).
const BASE = "http://localhost:8000/api";

export type MapNode = {
  id: string;
  type: "folder" | "file";
  name: string;
  files?: number;
  loc: number;
  kind?: "code" | "test" | "config";
  entry?: boolean;
  rank?: number;
  in_degree?: number;
  blurb?: string | null;      // the file's own top comment, if any
  summary?: string | null;    // AI summary (later)
  defines?: string[];         // main functions/classes
  routes?: string[];          // API routes it handles
  key_files?: string[];       // folders: most important files inside
};

export type MapEdge = {
  source: string;
  target: string;
  kind: "import" | "route";
  count?: number;
  confidence?: string;
};

export type FolderView = { folder: string; nodes: MapNode[]; edges: MapEdge[] };

export type GraphFile = {
  id: string; folder: string; lang: string; loc: number; kind: string; rank: number; in_degree: number;
  blurb?: string | null; summary?: string | null; defines?: string[]; routes?: string[];
};
export type Graph = { nodes: GraphFile[]; edges: MapEdge[] };

export type AiStatus = { configured: boolean; model: string; provider: string; provider_id?: string };
export type ModelHost = { id: string; label: string; env: string; configured: boolean; models: string[]; error: string | null };
export type ModelCatalog = { current: { provider: string; model: string }; providers: ModelHost[] };
export type AskStep = { file: string; start: number; end: number; claim: string; verified: boolean };
export type AskResult = { answer: string; steps: AskStep[]; tool_calls: number; seconds?: number; considered?: string[] };

export type SearchHit = { file: string; line: number; col: number; text: string };
export type SearchResult = { query: string; hits: SearchHit[]; truncated: boolean };
export type GitChange = { path: string; status: string };
export type GitStatus = {
  is_repo: boolean; branch?: string; upstream?: string | null; ahead?: number; behind?: number;
  changes?: GitChange[]; branches?: string[]; user?: { name: string; email: string };
};
export type RunInfo = { command: string | null; needs_install: boolean };

export type OpenResult = { root: string; name: string; stats: Record<string, unknown> };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, init);
  } catch {
    throw new Error("Can't reach the RepoBuddy server. Start it with: python -m uvicorn server:app --port 8000");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  health: () => call<{ ok: boolean; repo: string | null }>("/health"),
  open: (source: string) =>
    call<OpenResult>("/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
    }),
  folder: (path: string) => call<FolderView>(`/folder?path=${encodeURIComponent(path)}`),
  graph: () => call<Graph>("/graph"),
  file: (path: string) => call<{ path: string; text: string }>(`/file?path=${encodeURIComponent(path)}`),
  ai: () => call<AiStatus>("/ai"),
  models: () => call<ModelCatalog>("/models"),
  setModel: (provider: string, model: string) =>
    call<AiStatus>("/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, model }),
    }),
  ask: (question: string, focus_file: string | null) =>
    call<AskResult>("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, focus_file }),
    }),
  search: (q: string, folder = "") => call<SearchResult>(`/search?q=${encodeURIComponent(q)}&folder=${encodeURIComponent(folder)}`),
  fs: (op: "new_file" | "new_folder" | "rename" | "delete", path: string, new_path?: string) =>
    call<{ ok: boolean }>("/fs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, path, new_path }),
    }),
  git: () => call<GitStatus>("/git"),
  run: () => call<RunInfo>("/run"),
  save: (path: string, text: string) =>
    call<{ ok: boolean }>("/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, text }),
    }),
};
