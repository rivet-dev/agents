import { memo, useEffect, useRef, useState } from "react";
import { useStyletron } from "baseui";
import { LabelXSmall } from "baseui/typography";
import { History } from "lucide-react";

import { useFoundryTokens } from "../../app/theme";
import { formatMessageTimestamp, type HistoryEvent } from "./view-model";

export const HistoryMinimap = memo(function HistoryMinimap({ events, onSelect }: { events: HistoryEvent[]; onSelect: (event: HistoryEvent) => void }) {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (events.length === 0) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className={css({
        position: "absolute",
        top: "20px",
        right: "16px",
        zIndex: 3,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: "6px",
      })}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setOpen((prev) => !prev);
        }}
        className={css({
          width: "26px",
          height: "26px",
          borderRadius: "6px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          color: open ? t.textSecondary : t.textTertiary,
          backgroundColor: open ? t.interactiveHover : "transparent",
          transition: "background 200ms ease, color 200ms ease",
          ":hover": { color: t.textSecondary, backgroundColor: t.interactiveHover },
        })}
      >
        <History size={14} />
      </div>

      {open ? (
        <div
          className={css({
            width: "240px",
            maxHeight: "320px",
            overflowY: "auto",
            padding: "8px",
            borderRadius: "10px",
            backgroundColor: "rgba(32, 32, 32, 0.98)",
            backdropFilter: "blur(12px)",
            border: `1px solid ${t.borderDefault}`,
            boxShadow: `0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px ${t.interactiveSubtle}`,
          })}
        >
          <div className={css({ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px", padding: "0 4px" })}>
            <LabelXSmall color={t.textTertiary} $style={{ letterSpacing: "0.02em" }}>
              Task events
            </LabelXSmall>
            <LabelXSmall color={t.textTertiary}>{events.length}</LabelXSmall>
          </div>
          <div className={css({ display: "flex", flexDirection: "column", gap: "2px" })}>
            {events.map((event) => (
              <button
                key={event.id}
                type="button"
                onClick={() => {
                  onSelect(event);
                  setOpen(false);
                }}
                className={css({
                  appearance: "none",
                  WebkitAppearance: "none",
                  backgroundColor: "transparent",
                  border: "none",
                  margin: "0",
                  padding: "6px 8px",
                  borderRadius: "6px",
                  cursor: "pointer",
                  color: t.textSecondary,
                  fontSize: "12px",
                  fontWeight: 500,
                  textAlign: "left",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  transition: "background-color 160ms ease, color 160ms ease",
                  ":hover": {
                    backgroundColor: t.interactiveHover,
                    color: t.textPrimary,
                  },
                })}
              >
                {event.preview}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
});
