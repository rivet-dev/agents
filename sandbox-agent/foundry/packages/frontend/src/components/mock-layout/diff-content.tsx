import { memo, useMemo } from "react";
import { FileCode, Plus } from "lucide-react";

import { ScrollBody } from "./ui";
import { parseDiffLines, type FileChange } from "./view-model";

export const DiffContent = memo(function DiffContent({
  filePath,
  file,
  diff,
  onAddAttachment,
}: {
  filePath: string;
  file?: FileChange;
  diff?: string;
  onAddAttachment?: (filePath: string, lineNumber: number, lineContent: string) => void;
}) {
  const diffLines = useMemo(() => (diff ? parseDiffLines(diff) : []), [diff]);

  return (
    <>
      <div className="mock-diff-header">
        <FileCode size={14} color="#71717a" />
        <div className="mock-diff-path">{filePath}</div>
        {file ? (
          <div className="mock-diff-stats">
            <span className="mock-diff-added">+{file.added}</span>
            <span className="mock-diff-removed">&minus;{file.removed}</span>
          </div>
        ) : null}
      </div>
      <ScrollBody>
        {diff ? (
          <div className="mock-diff-body">
            {diffLines.map((line) => {
              const isHunk = line.kind === "hunk";
              return (
                <div
                  key={`${line.lineNumber}-${line.text}`}
                  className="mock-diff-row"
                  data-kind={line.kind}
                  style={!isHunk && onAddAttachment ? { cursor: "pointer" } : undefined}
                  onClick={!isHunk && onAddAttachment ? () => onAddAttachment(filePath, line.lineNumber, line.text) : undefined}
                >
                  <div className="mock-diff-gutter">
                    {!isHunk && onAddAttachment ? (
                      <button
                        type="button"
                        aria-label={`Attach line ${line.lineNumber}`}
                        tabIndex={-1}
                        className="mock-diff-attach-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onAddAttachment(filePath, line.lineNumber, line.text);
                        }}
                      >
                        <Plus size={13} />
                      </button>
                    ) : null}
                    <span className="mock-diff-line-number">{isHunk ? "" : line.lineNumber}</span>
                  </div>
                  <div data-selectable className="mock-diff-line-text">
                    {line.text}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mock-diff-empty">
            <div className="mock-diff-empty-copy">No diff data available for this file</div>
          </div>
        )}
      </ScrollBody>
    </>
  );
});
