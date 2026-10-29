// First screen: choose a repo to open.
import { useState } from "react";

type Props = { onOpen: (source: string) => Promise<void> };

const EXAMPLES = ["https://github.com/shadcn-ui/taxonomy", "https://github.com/expressjs/express"];

export function OpenScreen({ onOpen }: Props) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (value: string) => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onOpen(value.trim());
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="open-screen">
      <div className="sheet open-card" style={{ position: "relative" }}>
        <h1>Open a repository</h1>
        <p>Paste a GitHub link or the path of a folder on this computer. RepoBuddy reads the code and draws its map. Nothing in the repo is run.</p>
        <form
          className="open-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit(source);
          }}
        >
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="https://github.com/owner/repo  or  C:\path\to\folder"
            aria-label="GitHub link or folder path"
            autoFocus
          />
          <button type="submit" disabled={busy}>
            {busy ? "Building map…" : "Open"}
          </button>
        </form>
        <div className="examples">
          Try
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" disabled={busy} onClick={() => { setSource(ex); submit(ex); }}>
              {ex.replace("https://github.com/", "")}
            </button>
          ))}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </main>
  );
}
