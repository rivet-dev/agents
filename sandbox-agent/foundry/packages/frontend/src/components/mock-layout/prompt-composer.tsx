import { memo, type Ref } from "react";
import { useStyletron } from "baseui";
import { ChatComposer, type ChatComposerClassNames } from "@sandbox-agent/react";
import { FileCode, SendHorizonal, Square, X } from "lucide-react";
import { type WorkspaceModelGroup } from "@sandbox-agent/foundry-shared";

import { useFoundryTokens } from "../../app/theme";
import { ModelPicker } from "./model-picker";
import { PROMPT_TEXTAREA_MAX_HEIGHT, PROMPT_TEXTAREA_MIN_HEIGHT } from "./ui";
import { fileName, type LineAttachment, type ModelId } from "./view-model";

export const PromptComposer = memo(function PromptComposer({
  draft,
  textareaRef,
  placeholder,
  attachments,
  modelGroups,
  defaultModel,
  model,
  isRunning,
  onDraftChange,
  onSend,
  onStop,
  onRemoveAttachment,
  onChangeModel,
  onSetDefaultModel,
}: {
  draft: string;
  textareaRef: Ref<HTMLTextAreaElement>;
  placeholder: string;
  attachments: LineAttachment[];
  modelGroups: WorkspaceModelGroup[];
  defaultModel: ModelId;
  model: ModelId;
  isRunning: boolean;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onRemoveAttachment: (id: string) => void;
  onChangeModel: (model: ModelId) => void;
  onSetDefaultModel: (model: ModelId) => void;
}) {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const composerClassNames: Partial<ChatComposerClassNames> = {
    form: css({
      position: "relative",
      backgroundColor: t.interactiveHover,
      border: `1px solid ${t.borderDefault}`,
      borderRadius: "12px",
      minHeight: `${PROMPT_TEXTAREA_MIN_HEIGHT + 36}px`,
      transition: "border-color 200ms ease",
      ":focus-within": { borderColor: t.borderMedium },
      display: "flex",
      flexDirection: "column",
    }),
    input: css({
      display: "block",
      width: "100%",
      minHeight: `${PROMPT_TEXTAREA_MIN_HEIGHT + 20}px`,
      padding: "14px 58px 8px 14px",
      background: "transparent",
      border: "none",
      borderRadius: "12px 12px 0 0",
      color: t.textPrimary,
      fontSize: "13px",
      fontFamily: "inherit",
      resize: "none",
      outline: "none",
      lineHeight: "1.4",
      maxHeight: `${PROMPT_TEXTAREA_MAX_HEIGHT + 40}px`,
      boxSizing: "border-box",
      overflowY: "hidden",
      "::placeholder": { color: t.textSecondary },
    }),
    submit: css({
      appearance: "none",
      WebkitAppearance: "none",
      boxSizing: "border-box",
      width: "32px",
      height: "32px",
      padding: "0",
      margin: "0",
      border: "none",
      borderRadius: "10px",
      cursor: "pointer",
      position: "absolute",
      right: "12px",
      bottom: "12px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      lineHeight: 0,
      fontSize: 0,
      color: t.textPrimary,
      transition: "background 200ms ease",
      backgroundColor: isRunning ? t.interactiveHover : t.borderMedium,
      ":hover": {
        backgroundColor: isRunning ? t.borderMedium : "rgba(255, 255, 255, 0.20)",
      },
      ":disabled": {
        cursor: "not-allowed",
        opacity: 0.45,
      },
    }),
    submitContent: css({
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: "100%",
      height: "100%",
      lineHeight: 0,
      color: isRunning ? t.textPrimary : t.textPrimary,
    }),
  };

  return (
    <div
      className={css({
        padding: "12px 12px",
        borderTop: "none",
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      })}
    >
      {attachments.length > 0 ? (
        <div className={css({ display: "flex", flexWrap: "wrap", gap: "4px" })}>
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className={css({
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "2px 8px",
                borderRadius: "4px",
                backgroundColor: t.interactiveHover,
                border: `1px solid ${t.borderMedium}`,
                fontSize: "11px",
                fontFamily: '"IBM Plex Mono", monospace',
                color: t.textSecondary,
              })}
            >
              <FileCode size={11} />
              <span>
                {fileName(attachment.filePath)}:{attachment.lineNumber}
              </span>
              <X size={10} className={css({ cursor: "pointer", opacity: 0.6, ":hover": { opacity: 1 } })} onClick={() => onRemoveAttachment(attachment.id)} />
            </div>
          ))}
        </div>
      ) : null}
      <ChatComposer
        message={draft}
        onMessageChange={onDraftChange}
        onSubmit={isRunning ? onStop : onSend}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (isRunning) {
              onStop();
            } else {
              onSend();
            }
          }
        }}
        placeholder={placeholder}
        inputRef={textareaRef}
        rows={2}
        allowEmptySubmit={isRunning}
        submitLabel={isRunning ? "Stop" : "Send"}
        classNames={composerClassNames}
        renderSubmitContent={() => (isRunning ? <Square size={16} style={{ display: "block" }} /> : <SendHorizonal size={16} style={{ display: "block" }} />)}
        renderFooter={() => (
          <div className={css({ padding: "0 10px 8px" })}>
            <ModelPicker groups={modelGroups} value={model} defaultModel={defaultModel} onChange={onChangeModel} onSetDefault={onSetDefaultModel} />
          </div>
        )}
      />
    </div>
  );
});
