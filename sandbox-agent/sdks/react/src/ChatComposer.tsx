"use client";

import type { KeyboardEvent, ReactNode, Ref, TextareaHTMLAttributes } from "react";

export interface ChatComposerClassNames {
  root: string;
  form: string;
  input: string;
  submit: string;
  submitContent: string;
}

export interface ChatComposerProps {
  message: string;
  onMessageChange: (value: string) => void;
  onSubmit: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  submitDisabled?: boolean;
  allowEmptySubmit?: boolean;
  submitLabel?: string;
  className?: string;
  classNames?: Partial<ChatComposerClassNames>;
  inputRef?: Ref<HTMLTextAreaElement>;
  rows?: number;
  textareaProps?: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className" | "disabled" | "onChange" | "onKeyDown" | "placeholder" | "rows" | "value">;
  renderSubmitContent?: () => ReactNode;
  renderFooter?: () => ReactNode;
}

const DEFAULT_CLASS_NAMES: ChatComposerClassNames = {
  root: "sa-chat-composer",
  form: "sa-chat-composer-form",
  input: "sa-chat-composer-input",
  submit: "sa-chat-composer-submit",
  submitContent: "sa-chat-composer-submit-content",
};

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

const mergeClassNames = (defaults: ChatComposerClassNames, overrides?: Partial<ChatComposerClassNames>): ChatComposerClassNames => ({
  root: cx(defaults.root, overrides?.root),
  form: cx(defaults.form, overrides?.form),
  input: cx(defaults.input, overrides?.input),
  submit: cx(defaults.submit, overrides?.submit),
  submitContent: cx(defaults.submitContent, overrides?.submitContent),
});

export const ChatComposer = ({
  message,
  onMessageChange,
  onSubmit,
  onKeyDown,
  placeholder,
  disabled = false,
  submitDisabled = false,
  allowEmptySubmit = false,
  submitLabel = "Send",
  className,
  classNames: classNameOverrides,
  inputRef,
  rows = 1,
  textareaProps,
  renderSubmitContent,
  renderFooter,
}: ChatComposerProps) => {
  const resolvedClassNames = mergeClassNames(DEFAULT_CLASS_NAMES, classNameOverrides);
  const isSubmitDisabled = disabled || submitDisabled || (!allowEmptySubmit && message.trim().length === 0);

  return (
    <div className={cx(resolvedClassNames.root, className)} data-slot="root">
      <form
        className={resolvedClassNames.form}
        data-slot="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!isSubmitDisabled) {
            onSubmit();
          }
        }}
      >
        <textarea
          {...textareaProps}
          ref={inputRef}
          className={resolvedClassNames.input}
          data-slot="input"
          data-disabled={disabled ? "true" : undefined}
          data-empty={message.trim().length === 0 ? "true" : undefined}
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={rows}
          disabled={disabled}
        />
        {renderFooter?.()}
        <button
          type="submit"
          className={resolvedClassNames.submit}
          data-slot="submit"
          data-disabled={isSubmitDisabled ? "true" : undefined}
          disabled={isSubmitDisabled}
          aria-label={submitLabel}
          title={submitLabel}
        >
          <span className={resolvedClassNames.submitContent} data-slot="submit-content">
            {renderSubmitContent?.() ?? submitLabel}
          </span>
        </button>
      </form>
    </div>
  );
};
