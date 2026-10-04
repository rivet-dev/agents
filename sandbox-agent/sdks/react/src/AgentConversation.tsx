"use client";

import type { ReactNode, RefObject } from "react";
import { AgentTranscript, type AgentTranscriptClassNames, type AgentTranscriptProps, type TranscriptEntry } from "./AgentTranscript.tsx";
import { ChatComposer, type ChatComposerClassNames, type ChatComposerProps } from "./ChatComposer.tsx";

export interface AgentConversationClassNames {
  root: string;
  transcript: string;
  emptyState: string;
  composer: string;
}

export interface AgentConversationProps {
  entries: TranscriptEntry[];
  className?: string;
  classNames?: Partial<AgentConversationClassNames>;
  emptyState?: ReactNode;
  transcriptClassName?: string;
  transcriptClassNames?: Partial<AgentTranscriptClassNames>;
  scrollRef?: RefObject<HTMLDivElement | null>;
  composerClassName?: string;
  composerClassNames?: Partial<ChatComposerClassNames>;
  transcriptProps?: Omit<AgentTranscriptProps, "entries" | "className" | "classNames" | "scrollRef">;
  composerProps?: Omit<ChatComposerProps, "className" | "classNames">;
}

const DEFAULT_CLASS_NAMES: AgentConversationClassNames = {
  root: "sa-agent-conversation",
  transcript: "sa-agent-conversation-transcript",
  emptyState: "sa-agent-conversation-empty-state",
  composer: "sa-agent-conversation-composer",
};

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

const mergeClassNames = (defaults: AgentConversationClassNames, overrides?: Partial<AgentConversationClassNames>): AgentConversationClassNames => ({
  root: cx(defaults.root, overrides?.root),
  transcript: cx(defaults.transcript, overrides?.transcript),
  emptyState: cx(defaults.emptyState, overrides?.emptyState),
  composer: cx(defaults.composer, overrides?.composer),
});

export const AgentConversation = ({
  entries,
  className,
  classNames: classNameOverrides,
  emptyState,
  transcriptClassName,
  transcriptClassNames,
  scrollRef,
  composerClassName,
  composerClassNames,
  transcriptProps,
  composerProps,
}: AgentConversationProps) => {
  const resolvedClassNames = mergeClassNames(DEFAULT_CLASS_NAMES, classNameOverrides);
  const hasTranscriptContent = entries.length > 0 || Boolean(transcriptProps?.sessionError) || Boolean(transcriptProps?.eventError);

  return (
    <div className={cx(resolvedClassNames.root, className)} data-slot="root">
      {hasTranscriptContent ? (
        scrollRef ? (
          <div className={cx(resolvedClassNames.transcript, transcriptClassName)} data-slot="transcript" ref={scrollRef}>
            <AgentTranscript entries={entries} classNames={transcriptClassNames} {...transcriptProps} />
          </div>
        ) : (
          <AgentTranscript
            entries={entries}
            className={cx(resolvedClassNames.transcript, transcriptClassName)}
            classNames={transcriptClassNames}
            {...transcriptProps}
          />
        )
      ) : emptyState ? (
        <div className={resolvedClassNames.emptyState} data-slot="empty-state">
          {emptyState}
        </div>
      ) : null}
      {composerProps ? (
        <ChatComposer className={cx(resolvedClassNames.composer, composerClassName)} classNames={composerClassNames} {...composerProps} />
      ) : null}
    </div>
  );
};
