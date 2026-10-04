import { AgentTranscript as AgentTranscript_, type AgentTranscriptClassNames, type TranscriptEntry } from "@sandbox-agent/react";
import { memo, useEffect, useMemo, type MutableRefObject, type RefObject } from "react";

// Cast needed: tsup-generated .d.ts returns react_jsx_runtime.JSX.Element which
// doesn't unify with the consumer's JSX.Element under Bundler moduleResolution.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AgentTranscript = AgentTranscript_ as any as React.FC<{
  entries: TranscriptEntry[];
  classNames?: Partial<AgentTranscriptClassNames>;
  scrollRef?: RefObject<HTMLDivElement | null>;
  scrollToEntryId?: string | null;
  virtualize?: boolean;
  isThinking?: boolean;
  renderMessageText?: (entry: TranscriptEntry) => React.ReactNode;
  renderThinkingState?: () => React.ReactNode;
}>;
import { useStyletron } from "baseui";
import { LabelSmall, LabelXSmall } from "baseui/typography";
import { Copy } from "lucide-react";

import { useFoundryTokens } from "../../app/theme";
import { HistoryMinimap } from "./history-minimap";
import { SpinnerDot } from "./ui";
import { buildDisplayMessages, formatMessageDuration, formatMessageTimestamp, type AgentSession, type HistoryEvent, type Message } from "./view-model";

const TranscriptMessageBody = memo(function TranscriptMessageBody({
  message,
  messageRefs,
  copiedMessageId,
  onCopyMessage,
  isTarget,
  onTargetRendered,
}: {
  message: Message;
  messageRefs: MutableRefObject<Map<string, HTMLDivElement>>;
  copiedMessageId: string | null;
  onCopyMessage: (message: Message) => void;
  isTarget?: boolean;
  onTargetRendered?: () => void;
}) {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const isUser = message.sender === "client";
  const isCopied = copiedMessageId === message.id;
  const messageTimestamp = formatMessageTimestamp(message.createdAtMs);
  const displayFooter = isUser ? messageTimestamp : message.durationMs ? `${messageTimestamp} • Took ${formatMessageDuration(message.durationMs)}` : null;

  useEffect(() => {
    if (!isTarget) {
      return;
    }

    const targetNode = messageRefs.current.get(message.id);
    if (!targetNode) {
      return;
    }

    targetNode.scrollIntoView({ behavior: "smooth", block: "center" });
    onTargetRendered?.();
  }, [isTarget, message.id, messageRefs, onTargetRendered]);

  return (
    <div
      ref={(node) => {
        if (node) {
          messageRefs.current.set(message.id, node);
        } else {
          messageRefs.current.delete(message.id);
        }
      }}
      className={css({
        display: "flex",
        flexDirection: "column",
        alignItems: isUser ? "flex-end" : "flex-start",
        gap: "6px",
      })}
    >
      <div
        className={css({
          maxWidth: "80%",
          ...(isUser
            ? {
                padding: "12px 16px",
                backgroundColor: t.borderDefault,
                color: t.textPrimary,
                borderTopLeftRadius: "18px",
                borderTopRightRadius: "18px",
                borderBottomLeftRadius: "18px",
                borderBottomRightRadius: "4px",
              }
            : {
                backgroundColor: "transparent",
                border: "none",
                color: t.textPrimary,
                borderRadius: "0",
                padding: "0",
              }),
        })}
      >
        <div
          data-selectable
          className={css({
            fontSize: "13px",
            lineHeight: "1.6",
            whiteSpace: "pre-wrap",
            wordWrap: "break-word",
          })}
        >
          {message.text}
        </div>
      </div>
      <div
        className={css({
          display: "flex",
          alignItems: "center",
          gap: "10px",
          justifyContent: isUser ? "flex-end" : "flex-start",
          minHeight: "16px",
          paddingLeft: isUser ? undefined : "2px",
        })}
      >
        {displayFooter ? (
          <LabelXSmall color={t.textTertiary} $style={{ fontFamily: '"IBM Plex Mono", monospace', letterSpacing: "0.01em" }}>
            {displayFooter}
          </LabelXSmall>
        ) : null}
        <button
          type="button"
          data-copy-action="true"
          onClick={() => onCopyMessage(message)}
          className={css({
            appearance: "none",
            WebkitAppearance: "none",
            background: "none",
            border: "none",
            padding: "0",
            margin: "0",
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            fontSize: "11px",
            cursor: "pointer",
            color: isCopied ? t.textPrimary : t.textSecondary,
            transition: "color 160ms ease",
            ":hover": { color: t.textPrimary },
          })}
        >
          <Copy size={11} />
          {isCopied ? "Copied" : null}
        </button>
      </div>
    </div>
  );
});

export const MessageList = memo(function MessageList({
  session,
  scrollRef,
  messageRefs,
  historyEvents,
  onSelectHistoryEvent,
  targetMessageId,
  onTargetMessageResolved,
  copiedMessageId,
  onCopyMessage,
  thinkingTimerLabel,
  pendingMessage,
}: {
  session: AgentSession | null | undefined;
  scrollRef: RefObject<HTMLDivElement | null>;
  messageRefs: MutableRefObject<Map<string, HTMLDivElement>>;
  historyEvents: HistoryEvent[];
  onSelectHistoryEvent: (event: HistoryEvent) => void;
  targetMessageId?: string | null;
  onTargetMessageResolved?: () => void;
  copiedMessageId: string | null;
  onCopyMessage: (message: Message) => void;
  thinkingTimerLabel: string | null;
  pendingMessage: { text: string; sentAt: number } | null;
}) {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const PENDING_MESSAGE_ID = "__pending__";
  const messages = useMemo(() => buildDisplayMessages(session), [session]);
  const messagesById = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const messageIndexById = useMemo(() => new Map(messages.map((message, index) => [message.id, index])), [messages]);
  const transcriptEntries = useMemo<TranscriptEntry[]>(() => {
    const entries: TranscriptEntry[] = messages.map((message) => ({
      id: message.id,
      eventId: message.id,
      kind: "message",
      time: new Date(message.createdAtMs).toISOString(),
      role: message.sender === "client" ? "user" : "assistant",
      text: message.text,
    }));
    if (pendingMessage) {
      entries.push({
        id: PENDING_MESSAGE_ID,
        eventId: PENDING_MESSAGE_ID,
        kind: "message",
        time: new Date(pendingMessage.sentAt).toISOString(),
        role: "user",
        text: pendingMessage.text,
      });
    }
    return entries;
  }, [messages, pendingMessage]);

  const messageContentClass = css({
    maxWidth: "100%",
    display: "flex",
    flexDirection: "column",
  });

  const transcriptClassNames: Partial<AgentTranscriptClassNames> = {
    root: css({
      display: "flex",
      flexDirection: "column",
      gap: "12px",
    }),
    message: css({
      display: "flex",
    }),
    messageContent: messageContentClass,
    messageText: css({
      width: "100%",
    }),
    thinkingRow: css({
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "4px 0",
    }),
    thinkingIndicator: css({
      display: "flex",
      alignItems: "center",
      gap: "8px",
      color: t.accent,
      fontSize: "11px",
      fontFamily: '"IBM Plex Mono", monospace',
      letterSpacing: "0.01em",
    }),
  };
  const scrollContainerClass = css({
    padding: "16px 52px 16px 20px",
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
  });

  useEffect(() => {
    if (!targetMessageId) {
      return;
    }

    const targetNode = messageRefs.current.get(targetMessageId);
    if (targetNode) {
      targetNode.scrollIntoView({ behavior: "smooth", block: "center" });
      onTargetMessageResolved?.();
      return;
    }

    const targetIndex = messageIndexById.get(targetMessageId);
    if (targetIndex == null) {
      return;
    }

    scrollRef.current?.scrollTo({
      top: Math.max(0, targetIndex * 88),
      behavior: "smooth",
    });
  }, [messageIndexById, messageRefs, onTargetMessageResolved, scrollRef, targetMessageId]);

  return (
    <>
      <style>{`
        [data-variant="user"] > [data-slot="message-content"] {
          margin-left: auto;
        }
      `}</style>
      {historyEvents.length > 0 ? <HistoryMinimap events={historyEvents} onSelect={onSelectHistoryEvent} /> : null}
      <div ref={scrollRef} className={scrollContainerClass}>
        {session && transcriptEntries.length === 0 ? (
          <div
            className={css({
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              flex: 1,
              minHeight: "200px",
              gap: "8px",
            })}
          >
            <LabelSmall color={t.textTertiary}>
              {!session?.created ? "Choose an agent and model, then send your first message" : "No messages yet in this session"}
            </LabelSmall>
          </div>
        ) : (
          <AgentTranscript
            entries={transcriptEntries}
            classNames={transcriptClassNames}
            scrollRef={scrollRef}
            scrollToEntryId={targetMessageId}
            virtualize
            renderMessageText={(entry: TranscriptEntry) => {
              if (entry.id === PENDING_MESSAGE_ID && pendingMessage) {
                const pendingMsg: Message = {
                  id: PENDING_MESSAGE_ID,
                  sender: "client",
                  text: pendingMessage.text,
                  createdAtMs: pendingMessage.sentAt,
                  event: {
                    id: PENDING_MESSAGE_ID,
                    eventIndex: -1,
                    sessionId: "",
                    connectionId: "",
                    sender: "client",
                    createdAt: pendingMessage.sentAt,
                    payload: {},
                  },
                };
                return (
                  <div style={{ opacity: 0.5 }}>
                    <TranscriptMessageBody message={pendingMsg} messageRefs={messageRefs} copiedMessageId={copiedMessageId} onCopyMessage={onCopyMessage} />
                  </div>
                );
              }
              const message = messagesById.get(entry.id);
              if (!message) {
                return null;
              }

              return (
                <TranscriptMessageBody
                  message={message}
                  messageRefs={messageRefs}
                  copiedMessageId={copiedMessageId}
                  onCopyMessage={onCopyMessage}
                  isTarget={targetMessageId === entry.id}
                  onTargetRendered={onTargetMessageResolved}
                />
              );
            }}
            isThinking={Boolean((session && session.status === "running" && transcriptEntries.length > 0) || pendingMessage)}
            renderThinkingState={() => (
              <div className={transcriptClassNames.thinkingRow}>
                <SpinnerDot size={12} />
                <LabelXSmall color={t.accent} $style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span>Agent is thinking</span>
                  {thinkingTimerLabel ? (
                    <span
                      className={css({
                        padding: "2px 7px",
                        borderRadius: "999px",
                        backgroundColor: t.accentSubtle,
                        border: `1px solid rgba(255, 79, 0, 0.2)`,
                        fontFamily: '"IBM Plex Mono", monospace',
                        fontSize: "10px",
                        letterSpacing: "0.04em",
                      })}
                    >
                      {thinkingTimerLabel}
                    </span>
                  ) : null}
                </LabelXSmall>
              </div>
            )}
          />
        )}
      </div>
    </>
  );
});
