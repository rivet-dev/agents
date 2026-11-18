import { ChevronDown, ChevronRight, Clipboard } from "lucide-react";
import { useState } from "react";

import type { RequestLog } from "../../types/requestLog";
import { formatJson } from "../../utils/format";

const RequestLogTab = ({
  requestLog,
  copiedLogId,
  onClear,
  onCopy,
}: {
  requestLog: RequestLog[];
  copiedLogId: number | null;
  onClear: () => void;
  onCopy: (entry: RequestLog) => void;
}) => {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const toggleExpanded = (id: number) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <>
      <div className="inline-row" style={{ marginBottom: 12, justifyContent: "space-between" }}>
        <span className="card-meta">{requestLog.length} requests</span>
        <button className="button ghost small" onClick={onClear}>
          Clear
        </button>
      </div>

      {requestLog.length === 0 ? (
        <div className="card-meta">No requests logged yet.</div>
      ) : (
        <div className="event-list">
          {requestLog.map((entry) => {
            const isExpanded = expanded[entry.id] ?? false;
            const hasDetails = entry.headers || entry.body || entry.responseBody;
            return (
              <div key={entry.id} className={`event-item ${isExpanded ? "expanded" : "collapsed"}`}>
                <button
                  className="event-summary"
                  type="button"
                  onClick={() => hasDetails && toggleExpanded(entry.id)}
                  title={hasDetails ? (isExpanded ? "Collapse" : "Expand") : undefined}
                  style={{ cursor: hasDetails ? "pointer" : "default", gridTemplateColumns: "1fr auto auto auto" }}
                >
                  <div className="event-summary-main">
                    <div className="event-title-row">
                      <span className="log-method">{entry.method}</span>
                      <span className="log-url text-truncate" style={{ flex: 1 }}>
                        {entry.url}
                      </span>
                    </div>
                    <div className="event-id">
                      {entry.time}
                      {entry.error && ` - ${entry.error}`}
                    </div>
                  </div>
                  <span className={`log-status ${entry.status && entry.status < 400 ? "ok" : "error"}`}>{entry.status || "ERR"}</span>
                  <span
                    className="copy-button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCopy(entry);
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        onCopy(entry);
                      }
                    }}
                  >
                    <Clipboard size={14} />
                    {copiedLogId === entry.id ? "Copied" : "curl"}
                  </span>
                  {hasDetails && <span className="event-chevron">{isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>}
                </button>
                {isExpanded && (
                  <div className="event-payload" style={{ padding: "8px 12px" }}>
                    {entry.headers && Object.keys(entry.headers).length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div className="part-title">Request Headers</div>
                        <pre className="code-block">
                          {Object.entries(entry.headers)
                            .map(([k, v]) => `${k}: ${v}`)
                            .join("\n")}
                        </pre>
                      </div>
                    )}
                    {entry.body && (
                      <div style={{ marginBottom: 8 }}>
                        <div className="part-title">Request Body</div>
                        <pre className="code-block">{formatJsonSafe(entry.body)}</pre>
                      </div>
                    )}
                    {entry.responseBody && (
                      <div>
                        <div className="part-title">Response Body</div>
                        <pre className="code-block">{formatJsonSafe(entry.responseBody)}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
};

const formatJsonSafe = (text: string): string => {
  try {
    const parsed = JSON.parse(text);
    return formatJson(parsed);
  } catch {
    return text;
  }
};

export default RequestLogTab;
