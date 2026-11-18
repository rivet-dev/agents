import { memo, useState } from "react";
import { useStyletron } from "baseui";
import { StatefulPopover, PLACEMENT } from "baseui/popover";
import { ChevronUp, Star } from "lucide-react";
import { workspaceModelLabel, type WorkspaceModelGroup } from "@sandbox-agent/foundry-shared";

import { useFoundryTokens } from "../../app/theme";
import { AgentIcon } from "./ui";
import { type ModelId } from "./view-model";

const ModelPickerContent = memo(function ModelPickerContent({
  groups,
  value,
  defaultModel,
  onChange,
  onSetDefault,
  close,
}: {
  groups: WorkspaceModelGroup[];
  value: ModelId;
  defaultModel: ModelId;
  onChange: (id: ModelId) => void;
  onSetDefault: (id: ModelId) => void;
  close: () => void;
}) {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const [hoveredId, setHoveredId] = useState<ModelId | null>(null);

  return (
    <div className={css({ minWidth: "220px", padding: "6px 0" })}>
      {groups.map((group) => (
        <div key={group.provider}>
          <div
            className={css({
              padding: "6px 12px",
              fontSize: "10px",
              fontWeight: 700,
              color: t.textTertiary,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            })}
          >
            {group.provider}
          </div>
          {group.models.map((model) => {
            const isActive = model.id === value;
            const isDefault = model.id === defaultModel;
            const isHovered = model.id === hoveredId;
            const agent = group.agentKind;

            return (
              <div
                key={model.id}
                onMouseEnter={() => setHoveredId(model.id)}
                onMouseLeave={() => setHoveredId(null)}
                onClick={() => {
                  onChange(model.id);
                  close();
                }}
                className={css({
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 12px",
                  cursor: "pointer",
                  fontSize: "12px",
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? t.textPrimary : t.textSecondary,
                  borderRadius: "6px",
                  marginLeft: "4px",
                  marginRight: "4px",
                  ":hover": { backgroundColor: t.borderSubtle },
                })}
              >
                <AgentIcon agent={agent} size={12} />
                <span className={css({ flex: 1 })}>{model.label}</span>
                {isDefault ? <Star size={11} fill={t.accent} color={t.accent} /> : null}
                {!isDefault && isHovered ? (
                  <Star
                    size={11}
                    color={t.textTertiary}
                    className={css({ cursor: "pointer", ":hover": { color: t.accent } })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSetDefault(model.id);
                    }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
});

export const ModelPicker = memo(function ModelPicker({
  groups,
  value,
  defaultModel,
  onChange,
  onSetDefault,
}: {
  groups: WorkspaceModelGroup[];
  value: ModelId;
  defaultModel: ModelId;
  onChange: (id: ModelId) => void;
  onSetDefault: (id: ModelId) => void;
}) {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const [isOpen, setIsOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  return (
    <StatefulPopover
      placement={PLACEMENT.topLeft}
      triggerType="click"
      autoFocus={false}
      onOpen={() => setIsOpen(true)}
      onClose={() => setIsOpen(false)}
      overrides={{
        Body: {
          style: {
            backgroundColor: "rgba(32, 32, 32, 0.98)",
            backdropFilter: "blur(12px)",
            borderTopLeftRadius: "10px",
            borderTopRightRadius: "10px",
            borderBottomLeftRadius: "10px",
            borderBottomRightRadius: "10px",
            border: `1px solid ${t.borderDefault}`,
            boxShadow: `0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px ${t.interactiveSubtle}`,
            zIndex: 100,
          },
        },
        Inner: {
          style: {
            backgroundColor: "transparent",
            padding: "0",
          },
        },
      }}
      content={({ close }) => (
        <ModelPickerContent groups={groups} value={value} defaultModel={defaultModel} onChange={onChange} onSetDefault={onSetDefault} close={close} />
      )}
    >
      <div className={css({ display: "inline-flex" })}>
        <button
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          className={css({
            appearance: "none",
            WebkitAppearance: "none",
            border: "none",
            margin: "0",
            display: "flex",
            alignItems: "center",
            gap: "4px",
            cursor: "pointer",
            padding: "4px 8px",
            borderRadius: "6px",
            fontSize: "12px",
            fontWeight: 500,
            color: t.textTertiary,
            backgroundColor: "transparent",
            transition: "background 200ms ease, color 200ms ease",
            ":hover": { color: t.textSecondary, backgroundColor: t.interactiveHover },
          })}
        >
          {workspaceModelLabel(value, groups)}
          {(isHovered || isOpen) && <ChevronUp size={11} />}
        </button>
      </div>
    </StatefulPopover>
  );
});
