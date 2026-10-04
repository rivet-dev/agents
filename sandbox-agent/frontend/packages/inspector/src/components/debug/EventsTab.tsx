import {
  Ban,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleX,
  Command,
  CornerDownLeft,
  FilePen,
  FileText,
  FolderOpen,
  Hourglass,
  KeyRound,
  ListChecks,
  MessageSquare,
  Plug,
  Radio,
  ScrollText,
  Settings,
  ShieldCheck,
  SquarePlus,
  SquareTerminal,
  ToggleLeft,
  Trash2,
  Unplug,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionEvent } from "sandbox-agent";
import { formatJson, formatShortId, formatTime } from "../../utils/format";

type EventIconInfo = { Icon: LucideIcon; category: string };

function getEventIcon(method: string, payload: Record<string, unknown>): EventIconInfo {
  if (method === "session/update") {
    const params = payload.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    const updateType = update?.sessionUpdate as string | undefined;

    switch (updateType) {
      case "user_message_chunk":
        return { Icon: MessageSquare, category: "prompt" };
      case "agent_message_chunk":
        return { Icon: Bot, category: "update" };
      case "agent_thought_chunk":
        return { Icon: Brain, category: "update" };
      case "tool_call":
      case "tool_call_update":
        return { Icon: Wrench, category: "tool" };
      case "plan":
        return { Icon: ListChecks, category: "config" };
      case "available_commands_update":
        return { Icon: Command, category: "config" };
      case "current_mode_update":
        return { Icon: ToggleLeft, category: "config" };
      case "config_option_update":
        return { Icon: Settings, category: "config" };
      default:
        return { Icon: Radio, category: "update" };
    }
  }

  switch (method) {
    case "initialize":
      return { Icon: Plug, category: "connection" };
    case "authenticate":
      return { Icon: KeyRound, category: "connection" };
    case "session/new":
      return { Icon: SquarePlus, category: "session" };
    case "session/load":
      return { Icon: FolderOpen, category: "session" };
    case "session/prompt":
      return { Icon: MessageSquare, category: "prompt" };
    case "session/cancel":
      return { Icon: Ban, category: "cancel" };
    case "session/set_mode":
      return { Icon: ToggleLeft, category: "config" };
    case "session/set_config_option":
      return { Icon: Settings, category: "config" };
    case "session/request_permission":
      return { Icon: ShieldCheck, category: "permission" };
    case "fs/read_text_file":
      return { Icon: FileText, category: "filesystem" };
    case "fs/write_text_file":
      return { Icon: FilePen, category: "filesystem" };
    case "terminal/create":
      return { Icon: SquareTerminal, category: "terminal" };
    case "terminal/kill":
      return { Icon: CircleX, category: "terminal" };
    case "terminal/output":
      return { Icon: ScrollText, category: "terminal" };
    case "terminal/release":
      return { Icon: Trash2, category: "terminal" };
    case "terminal/wait_for_exit":
      return { Icon: Hourglass, category: "terminal" };
    case "_sandboxagent/session/detach":
      return { Icon: Unplug, category: "session" };
    case "(response)":
      return { Icon: CornerDownLeft, category: "response" };
    default:
      if (method.startsWith("_sandboxagent/")) {
        return { Icon: Radio, category: "connection" };
      }
      return { Icon: Circle, category: "response" };
  }
}

const EventsTab = ({
  events,
  onClear,
  highlightedEventId,
  onClearHighlight,
}: {
  events: SessionEvent[];
  onClear: () => void;
  highlightedEventId?: string | null;
  onClearHighlight?: () => void;
}) => {
  const [collapsedEvents, setCollapsedEvents] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = JSON.stringify(events, null, 2);
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
        .catch(() => {
          fallbackCopy(text);
        });
    } else {
      fallbackCopy(text);
    }
  };

  const fallbackCopy = (text: string) => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy events:", err);
    }
    document.body.removeChild(textarea);
  };

  useEffect(() => {
    if (events.length === 0) {
      setCollapsedEvents({});
    }
  }, [events.length]);

  // Scroll to highlighted event (with delay to ensure DOM is ready after tab switch)
  useEffect(() => {
    if (highlightedEventId) {
      const scrollToEvent = () => {
        const el = document.getElementById(`event-${highlightedEventId}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          // Clear highlight after animation
          setTimeout(() => {
            onClearHighlight?.();
          }, 2000);
        }
      };
      // Small delay to ensure tab switch and DOM render completes
      const timer = setTimeout(scrollToEvent, 100);
      return () => clearTimeout(timer);
    }
  }, [highlightedEventId, onClearHighlight]);

  const getMethod = (event: SessionEvent): string => {
    const payload = event.payload as Record<string, unknown>;
    return typeof payload.method === "string" ? payload.method : "(response)";
  };

  return (
    <>
      <div className="inline-row" style={{ marginBottom: 12, justifyContent: "space-between" }}>
        <span className="card-meta">{events.length} events</span>
        <div className="inline-row">
          <button type="button" className="button ghost small" onClick={handleCopy} disabled={events.length === 0} title="Copy all events as JSON">
            {copied ? "Copied" : "Copy JSON"}
          </button>
          <button className="button ghost small" onClick={onClear}>
            Clear
          </button>
        </div>
      </div>

      {events.length === 0 ? (
        <div className="card-meta">No events yet. Create a session and send a message.</div>
      ) : (
        <div className="event-list">
          {[...events].reverse().map((event) => {
            const eventKey = event.id;
            const isCollapsed = collapsedEvents[eventKey] ?? true;
            const toggleCollapsed = () =>
              setCollapsedEvents((prev) => ({
                ...prev,
                [eventKey]: !(prev[eventKey] ?? true),
              }));
            const method = getMethod(event);
            const payload = event.payload as Record<string, unknown>;
            const { Icon, category } = getEventIcon(method, payload);
            const time = formatTime(new Date(event.createdAt).toISOString());
            const senderClass = event.sender === "client" ? "client" : "agent";

            const isHighlighted = highlightedEventId === event.id;

            return (
              <div
                key={eventKey}
                id={`event-${event.id}`}
                className={`event-item ${isCollapsed ? "collapsed" : "expanded"} ${isHighlighted ? "highlighted" : ""}`}
              >
                <button className="event-summary" type="button" onClick={toggleCollapsed} title={isCollapsed ? "Expand payload" : "Collapse payload"}>
                  <span className={`event-icon ${category}`}>
                    <Icon size={14} />
                  </span>
                  <div className="event-summary-main">
                    <div className="event-title-row">
                      <span className={`event-type ${category}`}>{method}</span>
                      <span className={`pill ${senderClass === "client" ? "accent" : "success"}`}>{event.sender}</span>
                      <span className="event-time">{time}</span>
                    </div>
                    <div className="event-id" title={event.id}>
                      {formatShortId(event.id)}
                    </div>
                  </div>
                  <span className="event-chevron">{isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}</span>
                </button>
                {!isCollapsed && <pre className="code-block event-payload">{formatJson(event.payload)}</pre>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
};

export default EventsTab;
