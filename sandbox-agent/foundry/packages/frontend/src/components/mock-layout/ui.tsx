import { memo, useCallback, useEffect, useState, type MouseEvent } from "react";
import { styled, useStyletron } from "baseui";
import { GitPullRequest, GitPullRequestDraft } from "lucide-react";

import { useFoundryTokens } from "../../app/theme";
import { getFoundryTokens } from "../../styles/tokens";
import type { AgentKind, AgentSession } from "./view-model";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
}

export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  useEffect(() => {
    if (!menu) {
      return;
    }

    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [menu]);

  const open = useCallback((event: MouseEvent, items: ContextMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  }, []);

  return { menu, open, close: useCallback(() => setMenu(null), []) };
}

export const ContextMenuOverlay = memo(function ContextMenuOverlay({
  menu,
  onClose,
}: {
  menu: { x: number; y: number; items: ContextMenuItem[] };
  onClose: () => void;
}) {
  const [css] = useStyletron();
  const t = useFoundryTokens();

  return (
    <div
      className={css({
        position: "fixed",
        zIndex: 9999,
        top: `${menu.y}px`,
        left: `${menu.x}px`,
        backgroundColor: t.surfaceElevated,
        border: `1px solid ${t.borderMedium}`,
        borderRadius: "8px",
        padding: "4px 0",
        minWidth: "160px",
        boxShadow: t.shadow,
      })}
    >
      {menu.items.map((item, index) => (
        <div
          key={index}
          onClick={() => {
            item.onClick();
            onClose();
          }}
          className={css({
            padding: "8px 14px",
            fontSize: "12px",
            color: t.textPrimary,
            cursor: "pointer",
            ":hover": { backgroundColor: t.interactiveHover },
          })}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
});

export const SpinnerDot = memo(function SpinnerDot({ size = 10 }: { size?: number }) {
  const t = useFoundryTokens();

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: `2px solid ${t.accentSubtle}`,
        borderTopColor: t.accent,
        animation: "hf-spin 0.8s linear infinite",
        flexShrink: 0,
      }}
    />
  );
});

export const UnreadDot = memo(function UnreadDot() {
  const t = useFoundryTokens();

  return (
    <div
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        backgroundColor: t.accent,
        flexShrink: 0,
      }}
    />
  );
});

export const TaskIndicator = memo(function TaskIndicator({
  isRunning,
  isProvisioning,
  hasUnread,
  isDraft,
}: {
  isRunning: boolean;
  isProvisioning: boolean;
  hasUnread: boolean;
  isDraft: boolean;
}) {
  const t = useFoundryTokens();

  if (isRunning) return <SpinnerDot size={8} />;
  if (isProvisioning) return <SpinnerDot size={8} />;
  if (hasUnread) return <UnreadDot />;
  if (isDraft) return <GitPullRequestDraft size={12} color={t.textSecondary} />;
  return <GitPullRequest size={12} color={t.statusSuccess} />;
});

const ClaudeIcon = memo(function ClaudeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1200 1200" fill="none" style={{ flexShrink: 0 }}>
      <path
        fill="#D97757"
        d="M 233.96 800.21 L 468.64 668.54 L 472.59 657.1 L 468.64 650.74 L 457.21 650.74 L 417.99 648.32 L 283.89 644.7 L 167.6 639.87 L 54.93 633.83 L 26.58 627.79 L 0 592.75 L 2.74 575.28 L 26.58 559.25 L 60.72 562.23 L 136.19 567.38 L 249.42 575.19 L 331.57 580.03 L 453.26 592.67 L 472.59 592.67 L 475.33 584.86 L 468.72 580.03 L 463.57 575.19 L 346.39 495.79 L 219.54 411.87 L 153.1 363.54 L 117.18 339.06 L 99.06 316.11 L 91.25 266.01 L 123.87 230.09 L 167.68 233.07 L 178.87 236.05 L 223.25 270.2 L 318.04 343.57 L 441.83 434.74 L 459.95 449.8 L 467.19 444.64 L 468.08 441.02 L 459.95 427.41 L 392.62 305.72 L 320.78 181.93 L 288.81 130.63 L 280.35 99.87 C 277.37 87.22 275.19 76.59 275.19 63.62 L 312.32 13.21 L 332.86 6.6 L 382.39 13.21 L 403.25 31.33 L 434.01 101.72 L 483.87 212.54 L 561.18 363.22 L 583.81 407.92 L 595.89 449.32 L 600.4 461.96 L 608.21 461.96 L 608.21 454.71 L 614.58 369.83 L 626.34 265.61 L 637.77 131.52 L 641.72 93.75 L 660.4 48.48 L 697.53 24 L 726.52 37.85 L 750.36 72 L 747.06 94.07 L 732.89 186.2 L 705.1 330.52 L 686.98 427.17 L 697.53 427.17 L 709.61 415.09 L 758.5 350.17 L 840.64 247.49 L 876.89 206.74 L 919.17 161.72 L 946.31 140.3 L 997.61 140.3 L 1035.38 196.43 L 1018.47 254.42 L 965.64 321.42 L 921.83 378.2 L 859.01 462.77 L 819.79 530.42 L 823.41 535.81 L 832.75 534.93 L 974.66 504.72 L 1051.33 490.87 L 1142.82 475.17 L 1184.21 494.5 L 1188.72 514.15 L 1172.46 554.34 L 1074.6 578.5 L 959.84 601.45 L 788.94 641.88 L 786.85 643.41 L 789.26 646.39 L 866.26 653.64 L 899.19 655.41 L 979.81 655.41 L 1129.93 666.6 L 1169.15 692.54 L 1192.67 724.27 L 1188.72 748.43 L 1128.32 779.19 L 1046.82 759.87 L 856.59 714.6 L 791.36 698.34 L 782.34 698.34 L 782.34 703.73 L 836.7 756.89 L 936.32 846.85 L 1061.07 962.82 L 1067.44 991.49 L 1051.41 1014.12 L 1034.5 1011.7 L 924.89 929.23 L 882.6 892.11 L 786.85 811.49 L 780.48 811.49 L 780.48 819.95 L 802.55 852.24 L 919.09 1027.41 L 925.13 1081.13 L 916.67 1098.6 L 886.47 1109.15 L 853.29 1103.11 L 785.07 1007.36 L 714.68 899.52 L 657.91 802.87 L 650.98 806.82 L 617.48 1167.7 L 601.77 1186.15 L 565.53 1200 L 535.33 1177.05 L 519.3 1139.92 L 535.33 1066.55 L 554.66 970.79 L 570.36 894.68 L 584.54 800.13 L 592.99 768.72 L 592.43 766.63 L 585.5 767.52 L 514.23 865.37 L 405.83 1011.87 L 320.05 1103.68 L 299.52 1111.81 L 263.92 1093.37 L 267.22 1060.43 L 287.11 1031.11 L 405.83 880.11 L 477.42 786.52 L 523.65 732.48 L 523.33 724.67 L 520.59 724.67 L 205.29 929.4 L 149.15 936.64 L 124.99 914.01 L 127.97 876.89 L 139.41 864.81 L 234.2 799.57 Z"
      />
    </svg>
  );
});

const OpenAIIcon = memo(function OpenAIIcon({ size = 14 }: { size?: number }) {
  const t = useFoundryTokens();

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path
        d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364l2.0153-1.1639a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
        fill={t.textPrimary}
      />
    </svg>
  );
});

const CursorIcon = memo(function CursorIcon({ size = 14 }: { size?: number }) {
  const t = useFoundryTokens();

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <rect x="3" y="3" width="18" height="18" rx="4" stroke={t.textSecondary} strokeWidth="1.5" />
      <path d="M8 12h8M12 8v8" stroke={t.textSecondary} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
});

export const AgentIcon = memo(function AgentIcon({ agent, size = 14 }: { agent: AgentKind; size?: number }) {
  switch (agent) {
    case "Claude":
      return <ClaudeIcon size={size} />;
    case "Codex":
      return <OpenAIIcon size={size} />;
    case "Cursor":
      return <CursorIcon size={size} />;
    default:
      return <CursorIcon size={size} />;
  }
});

export type HeaderStatusVariant = "error" | "warning" | "success" | "neutral";

export interface HeaderStatusInfo {
  variant: HeaderStatusVariant;
  label: string;
  spinning: boolean;
  tooltip?: string;
}

export const HeaderStatusPill = memo(function HeaderStatusPill({ status }: { status: HeaderStatusInfo }) {
  const [css] = useStyletron();
  const t = useFoundryTokens();

  const colorMap: Record<HeaderStatusVariant, { bg: string; text: string; dot: string }> = {
    error: { bg: `${t.statusError}18`, text: t.statusError, dot: t.statusError },
    warning: { bg: `${t.statusWarning}18`, text: t.statusWarning, dot: t.statusWarning },
    success: { bg: `${t.statusSuccess}18`, text: t.statusSuccess, dot: t.statusSuccess },
    neutral: { bg: t.interactiveSubtle, text: t.textTertiary, dot: t.textTertiary },
  };
  const colors = colorMap[status.variant];

  return (
    <div
      title={status.tooltip}
      className={css({
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: "2px 8px",
        borderRadius: "999px",
        backgroundColor: colors.bg,
        fontSize: "11px",
        fontWeight: 500,
        lineHeight: 1,
        color: colors.text,
        whiteSpace: "nowrap",
        flexShrink: 0,
      })}
    >
      {status.spinning ? (
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            border: `1.5px solid ${colors.dot}40`,
            borderTopColor: colors.dot,
            animation: "hf-spin 0.8s linear infinite",
            flexShrink: 0,
          }}
        />
      ) : (
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: colors.dot,
            flexShrink: 0,
          }}
        />
      )}
      <span>{status.label}</span>
    </div>
  );
});

export const SessionAvatar = memo(function SessionAvatar({ session }: { session: AgentSession }) {
  if (session.status === "running" || session.status === "pending_provision" || session.status === "pending_session_create") return <SpinnerDot size={8} />;
  if (session.unread) return <UnreadDot />;
  return <AgentIcon agent={session.agent} size={13} />;
});

export const Shell = styled("div", ({ $theme }) => {
  const t = getFoundryTokens($theme);
  return {
    display: "flex",
    height: "100dvh",
    backgroundColor: t.surfaceSecondary,
    overflow: "hidden",
  };
});

export const SPanel = styled("section", ({ $theme }) => {
  const t = getFoundryTokens($theme);
  return {
    minHeight: 0,
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    backgroundColor: t.surfaceSecondary,
    overflow: "hidden",
  };
});

export const ScrollBody = styled("div", () => ({
  minHeight: 0,
  flex: 1,
  position: "relative" as const,
  overflowY: "auto" as const,
  display: "flex",
  flexDirection: "column" as const,
}));

export const HEADER_HEIGHT = "42px";
export const PROMPT_TEXTAREA_MIN_HEIGHT = 56;
export const PROMPT_TEXTAREA_MAX_HEIGHT = 100;

export const PanelHeaderBar = styled("div", ({ $theme }) => {
  const t = getFoundryTokens($theme);
  return {
    display: "flex",
    alignItems: "center",
    minHeight: HEADER_HEIGHT,
    maxHeight: HEADER_HEIGHT,
    paddingTop: "0",
    paddingRight: "14px",
    paddingBottom: "0",
    paddingLeft: "14px",
    borderBottom: `1px solid ${t.borderDefault}`,
    backgroundColor: t.surfaceTertiary,
    gap: "8px",
    flexShrink: 0,
    position: "relative" as const,
    zIndex: 9999,
  };
});
