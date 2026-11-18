import type { ComponentType } from "react";
import {
  Activity,
  AlertTriangle,
  Brain,
  CircleDot,
  Download,
  FileDiff,
  Gauge,
  GitBranch,
  HelpCircle,
  Image,
  Layers,
  MessageSquare,
  Paperclip,
  PlayCircle,
  Plug,
  Shield,
  Terminal,
  Wrench,
} from "lucide-react";
import type { FeatureCoverageView } from "../../types/agents";

const badges = [
  { key: "planMode", label: "Plan", icon: GitBranch },
  { key: "permissions", label: "Perms", icon: Shield },
  { key: "questions", label: "Q&A", icon: HelpCircle },
  { key: "toolCalls", label: "Tool Calls", icon: Wrench },
  { key: "toolResults", label: "Tool Results", icon: Download },
  { key: "textMessages", label: "Text", icon: MessageSquare },
  { key: "images", label: "Images", icon: Image },
  { key: "fileAttachments", label: "Files", icon: Paperclip },
  { key: "sessionLifecycle", label: "Lifecycle", icon: PlayCircle },
  { key: "errorEvents", label: "Errors", icon: AlertTriangle },
  { key: "reasoning", label: "Reasoning", icon: Brain },
  { key: "status", label: "Status", icon: Gauge },
  { key: "commandExecution", label: "Commands", icon: Terminal },
  { key: "fileChanges", label: "File Changes", icon: FileDiff },
  { key: "mcpTools", label: "MCP", icon: Plug },
  { key: "streamingDeltas", label: "Deltas", icon: Activity },
  { key: "itemStarted", label: "Item Start", icon: CircleDot },
  { key: "variants", label: "Variants", icon: Layers },
] as const;

type BadgeItem = (typeof badges)[number];

const getEnabled = (featureCoverage: FeatureCoverageView, key: BadgeItem["key"]) =>
  Boolean((featureCoverage as unknown as Record<string, boolean | undefined>)[key]);

const FeatureCoverageBadges = ({ featureCoverage }: { featureCoverage: FeatureCoverageView }) => {
  return (
    <div className="feature-coverage-badges">
      {badges.map(({ key, label, icon: Icon }) => (
        <span key={key} className={`feature-coverage-badge ${getEnabled(featureCoverage, key) ? "enabled" : "disabled"}`}>
          <Icon size={12} />
          <span>{label}</span>
        </span>
      ))}
    </div>
  );
};

export default FeatureCoverageBadges;
