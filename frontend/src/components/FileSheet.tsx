// Bottom sheet that shows a file's code. (The full Monaco editor and terminal replace this next.)
type Props = { path: string; text: string | null; onClose: () => void; withTree: boolean };

export function FileSheet({ path, text, onClose, withTree }: Props) {
  return (
    <section className={"sheet file-sheet" + (withTree ? " with-tree-sheet" : "")} aria-label="File">
      <div className="sheet-tabs">
        <span className="tab">{path}</span>
        <button className="close" onClick={onClose} aria-label="Close file">
          Close
        </button>
      </div>
      <pre className="code">
        {text === null
          ? "Loading…"
          : text.split("\n").map((line, i) => (
              <div className="ln" key={i}>
                <span className="n">{i + 1}</span>
                <span>{line || " "}</span>
              </div>
            ))}
      </pre>
    </section>
  );
}
