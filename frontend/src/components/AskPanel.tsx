// The agent sidebar: ask a question about the repo, get an answer plus numbered steps.
// Each step points at real lines; click one to open it. The steps are also drawn as a path on the map.
import { useEffect, useRef, useState } from "react";
import type { AiStatus, AskStep } from "../api";
import { ModelPicker } from "./ModelPicker";
import { SendIcon } from "./Icons";

export type Turn = {
  id: number;
  question: string;
  state: "thinking" | "done" | "error";
  answer?: string;
  steps?: AskStep[];
  error?: string;
  meta?: string;
};

type Props = {
  ai: AiStatus | null;
  turns: Turn[];
  activeTurn: number | null;
  activeStep: number | null;
  focusFile: string | null;
  onAsk: (question: string) => void;
  onStep: (turnId: number, index: number) => void;
  onShowPath: (turnId: number) => void;
  onLeaveStep: () => void;  // click the selected step again (or Esc) to go back to all steps
  draft?: { text: string; nonce: number };
  onModelChange: (ai: AiStatus) => void; // text to put in the question box (from "Add to question")
};

// Answers are plain text with a little structure: blank lines split paragraphs, "- " lines are bullets,
// and `backticks` mark names from the code.
function inline(text: string) {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code> : part,
  );
}
function Answer({ text }: { text: string }) {
  const blocks = text.replace(/\r/g, "").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return (
    <div className="a">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*[-*•] /.test(l)))
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*•] /, ""))}</li>)}</ul>;
        return <p key={i}>{lines.map((l, j) => <span key={j}>{j > 0 && <br />}{inline(l.replace(/^\s*[-*•] /, "• "))}</span>)}</p>;
      })}
    </div>
  );
}

const STARTERS = [
  "What does this project do, and where does it start?",
  "How does a request get from the page to the database?",
  "Where is login handled?",
];

export function AskPanel({ ai, turns, activeTurn, activeStep, focusFile, onAsk, onStep, onShowPath, onLeaveStep, draft, onModelChange }: Props) {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!draft) return;
    setText((t) => (t.trim() ? `${t.trimEnd()} ${draft.text}` : draft.text));
    requestAnimationFrame(() => { box.current?.focus(); box.current?.setSelectionRange(9999, 9999); });
  }, [draft?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useRef<HTMLDivElement>(null);
  const busy = turns.some((t) => t.state === "thinking");

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [turns.length, turns.at(-1)?.state]);

  const submit = (q: string) => {
    if (!q.trim() || busy) return;
    onAsk(q.trim());
    setText("");
  };

  return (
    <aside className="sheet ask-panel" aria-label="Ask the repo">
      <header className="panel-head">
        <h2>Ask the repo</h2>
      </header>

      <div className="ask-list" ref={list}>
        {ai && !ai.configured && (
          <div className="ask-note">
            <b>Connect a model to start asking.</b> Copy <code>backend/.env.example</code> to <code>backend/.env</code>, paste your key
            into <code>LLM_API_KEY</code>, and restart the server. The map, editor and terminal work without it.
          </div>
        )}
        {turns.length === 0 && ai?.configured && (
          <div className="starters">
            <p>Ask anything about this code. Answers point at the exact lines and light up the path on the map.</p>
            {STARTERS.map((s) => (
              <button key={s} onClick={() => submit(s)}>{s}</button>
            ))}
          </div>
        )}
        {turns.map((t) => (
          <section key={t.id} className="turn">
            <p className="q">{t.question}</p>
            {t.state === "thinking" && <p className="thinking">Finding the right files on the map, then reading them…</p>}
            {t.state === "error" && <p className="error">{t.error}</p>}
            {t.state === "done" && (
              <>
                <Answer text={t.answer ?? ""} />
                {t.meta && <p className="meta">{t.meta}</p>}
                {!!t.steps?.length && (
                  <>
                    <ol className={"steps" + (activeTurn === t.id ? " active" : "")}>
                      {t.steps.map((s, i) => (
                        <li key={i} className={(s.verified ? "" : "unverified ") + (activeTurn === t.id && activeStep === i ? "on" : "")}>
                          <button
                            onClick={() => (activeTurn === t.id && activeStep === i ? onLeaveStep() : onStep(t.id, i))}
                            aria-pressed={activeTurn === t.id && activeStep === i}
                          >
                            <span className="num">{i + 1}</span>
                            <span className="where">
                              {s.file}
                              {s.verified ? `, lines ${s.start}–${s.end}` : ", not found in the code"}
                            </span>
                            <span className="claim">{s.claim}</span>
                          </button>
                        </li>
                      ))}
                    </ol>
                    {activeTurn !== t.id && (
                      <button className="link-btn" onClick={() => onShowPath(t.id)}>Show this path on the map</button>
                    )}
                  </>
                )}
              </>
            )}
          </section>
        ))}
      </div>

      <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(text); }} onClick={() => box.current?.focus()}>
        <textarea
          ref={box}
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(text); } }}
          placeholder={focusFile ? `Ask about ${focusFile.split("/").pop()} or anything else` : "Ask about this repo"}
          aria-label="Your question"
          disabled={!ai?.configured}
        />
        <div className="composer-bar" onClick={(e) => e.stopPropagation()}>
          <ModelPicker ai={ai} onChange={onModelChange} />
          <button
            type="submit"
            className="send-btn"
            disabled={busy || !text.trim() || !ai?.configured}
            aria-label={busy ? "Answering…" : "Ask"}
            title={busy ? "Answering…" : "Ask (Enter)"}
          >
            {busy ? <span className="send-wait" /> : <SendIcon />}
          </button>
        </div>
      </form>
    </aside>
  );
}
