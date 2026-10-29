// The slim rounded rail on the left. Tools on top; your account and settings kept apart at the bottom.
import type React from "react";
import { AskIcon, BranchIcon, FilesIcon, GearIcon, SearchIcon, UserIcon } from "./Icons";

export type SidePanel = "files" | "search" | "git";
export type Popup = "account" | "settings";

type Props = {
  side: SidePanel | null;
  askOpen: boolean;
  popup: Popup | null;
  changes: number;
  onSide: (p: SidePanel) => void;
  onAsk: () => void;
  onPopup: (p: Popup) => void;
};

const TOOLS: { id: SidePanel; label: string; icon: () => React.ReactElement; keys: string }[] = [
  { id: "files", label: "Files", icon: FilesIcon, keys: "Ctrl+Shift+E" },
  { id: "search", label: "Search", icon: SearchIcon, keys: "Ctrl+Shift+F" },
  { id: "git", label: "Branches and changes", icon: BranchIcon, keys: "Ctrl+Shift+G" },
];

export function Rail({ side, askOpen, popup, changes, onSide, onAsk, onPopup }: Props) {
  return (
    <nav className="sheet rail" aria-label="Tools">
      <div className="rail-group">
        {TOOLS.map(({ id, label, icon: Icon, keys }) => (
          <button key={id} className="rail-btn" aria-pressed={side === id} onClick={() => onSide(id)} title={`${label} (${keys})`} aria-label={label}>
            <Icon />
            {id === "git" && changes > 0 && <span className="badge">{changes > 99 ? "99+" : changes}</span>}
          </button>
        ))}
        <button className="rail-btn" aria-pressed={askOpen} onClick={onAsk} title="Ask the repo" aria-label="Ask the repo">
          <AskIcon />
        </button>
      </div>
      <div className="rail-group rail-bottom">
        <button className="rail-btn" aria-pressed={popup === "account"} onClick={() => onPopup("account")} title="Account" aria-label="Account">
          <UserIcon />
        </button>
        <button className="rail-btn" aria-pressed={popup === "settings"} onClick={() => onPopup("settings")} title="Settings" aria-label="Settings">
          <GearIcon />
        </button>
      </div>
    </nav>
  );
}
