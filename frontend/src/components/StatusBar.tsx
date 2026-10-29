// The thin rounded strip along the bottom: branch, sync, Go Live, AI model.
import type { AiStatus, GitStatus } from "../api";
import { BranchIcon, LiveIcon, SyncIcon } from "./Icons";

type Props = {
  git: GitStatus | null;
  syncing: boolean;
  files: number;
  ai: AiStatus | null;
  onBranch: () => void;
  onSync: () => void;
  onGoLive: () => void;
  onAi: () => void;
};

export function StatusBar({ git, syncing, files, ai, onBranch, onSync, onGoLive, onAi }: Props) {
  const changes = git?.changes?.length ?? 0;
  return (
    <footer className="sheet statusbar">
      {git?.is_repo ? (
        <button onClick={onBranch} title="Branches and changes">
          <BranchIcon />
          <b>{git.branch}</b>
          {!!git.behind && <span title="commits to pull">↓{git.behind}</span>}
          {!!git.ahead && <span title="commits to push">↑{git.ahead}</span>}
          {changes > 0 && <span className="quiet">{changes} changed</span>}
        </button>
      ) : (
        <span className="quiet">Not a git repo</span>
      )}
      <button onClick={onSync} title="Re-read the repo and redraw the map">
        <span className={syncing ? "spin" : ""}><SyncIcon /></span>
        {syncing ? "Updating map…" : `Map up to date, ${files.toLocaleString()} files`}
      </button>
      <span className="spacer" />
      <button onClick={onAi} title={ai?.configured ? `${ai.model} via ${ai.provider}` : "No AI model connected"}>
        <i className={"led" + (ai?.configured ? " on" : "")} />
        {ai?.configured ? ai.model : "AI not connected"}
      </button>
      <button className="go-live" onClick={onGoLive} title="Start this project in the terminal">
        <LiveIcon />
        Go Live
      </button>
    </footer>
  );
}
