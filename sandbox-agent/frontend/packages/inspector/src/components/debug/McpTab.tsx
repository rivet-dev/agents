import { ChevronDown, ChevronRight, FolderOpen, Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SandboxAgent } from "sandbox-agent";
import { formatJson } from "../../utils/format";

type McpEntry = {
  name: string;
  config: Record<string, unknown>;
};

const MCP_DIRECTORY_STORAGE_KEY = "sandbox-agent-inspector-mcp-directory";

const McpTab = ({ getClient }: { getClient: () => SandboxAgent }) => {
  const [directory, setDirectory] = useState(() => {
    if (typeof window === "undefined") return "/";
    try {
      return window.localStorage.getItem(MCP_DIRECTORY_STORAGE_KEY) ?? "/";
    } catch {
      return "/";
    }
  });
  const [entries, setEntries] = useState<McpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsedServers, setCollapsedServers] = useState<Record<string, boolean>>({});

  // Add/edit form state
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editJson, setEditJson] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadAll = useCallback(
    async (dir: string) => {
      setLoading(true);
      setError(null);
      try {
        const configPath = `${dir === "/" ? "" : dir}/.sandbox-agent/config/mcp.json`;
        const bytes = await getClient().readFsFile({ path: configPath });
        const text = new TextDecoder().decode(bytes);
        if (!text.trim()) {
          setEntries([]);
          return;
        }
        const map = JSON.parse(text) as Record<string, Record<string, unknown>>;
        setEntries(Object.entries(map).map(([name, config]) => ({ name, config })));
      } catch {
        // File doesn't exist yet or is empty — that's fine
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [getClient],
  );

  useEffect(() => {
    loadAll(directory);
  }, [directory, loadAll]);

  useEffect(() => {
    try {
      window.localStorage.setItem(MCP_DIRECTORY_STORAGE_KEY, directory);
    } catch {
      // Ignore storage failures.
    }
  }, [directory]);

  const startAdd = () => {
    setEditing(true);
    setEditName("");
    setEditJson('{\n  "type": "local",\n  "command": "npx",\n  "args": ["@modelcontextprotocol/server-everything"]\n}');
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditName("");
    setEditJson("");
    setEditError(null);
  };

  const save = async () => {
    const name = editName.trim();
    if (!name) {
      setEditError("Name is required");
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(editJson.trim());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setEditError("Must be a JSON object");
        return;
      }
    } catch {
      setEditError("Invalid JSON");
      return;
    }

    setSaving(true);
    setEditError(null);
    try {
      await getClient().setMcpConfig({ directory, mcpName: name }, parsed as Parameters<SandboxAgent["setMcpConfig"]>[1]);
      cancelEdit();
      await loadAll(directory);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (name: string) => {
    try {
      await getClient().deleteMcpConfig({ directory, mcpName: name });
      await loadAll(directory);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  return (
    <>
      <div className="inline-row" style={{ marginBottom: 12, justifyContent: "space-between" }}>
        <span className="card-meta">MCP Server Configuration</span>
        <div className="inline-row">
          {!editing && (
            <button className="button secondary small" onClick={startAdd}>
              <Plus className="button-icon" style={{ width: 12, height: 12 }} />
              Add
            </button>
          )}
        </div>
      </div>

      <div className="inline-row" style={{ marginBottom: 12, gap: 6 }}>
        <FolderOpen size={14} className="muted" style={{ flexShrink: 0 }} />
        <input
          className="setup-input mono"
          value={directory}
          onChange={(e) => setDirectory(e.target.value)}
          placeholder="/"
          style={{ flex: 1, fontSize: 11 }}
        />
      </div>

      {error && <div className="banner error">{error}</div>}
      {loading && <div className="card-meta">Loading...</div>}

      {editing && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-header">
            <span className="card-title">{editName ? `Edit: ${editName}` : "Add MCP Server"}</span>
          </div>
          <div style={{ marginTop: 8 }}>
            <input
              className="setup-input"
              value={editName}
              onChange={(e) => {
                setEditName(e.target.value);
                setEditError(null);
              }}
              placeholder="server-name"
              style={{ marginBottom: 8, width: "100%", boxSizing: "border-box" }}
            />
            <textarea
              className="setup-input mono"
              value={editJson}
              onChange={(e) => {
                setEditJson(e.target.value);
                setEditError(null);
              }}
              rows={6}
              style={{ width: "100%", boxSizing: "border-box", fontFamily: "monospace", fontSize: 11, resize: "vertical" }}
            />
            {editError && (
              <div className="banner error" style={{ marginTop: 4 }}>
                {editError}
              </div>
            )}
          </div>
          <div className="card-actions">
            <button className="button primary small" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="button-icon spinner-icon" /> : null}
              Save
            </button>
            <button className="button ghost small" onClick={cancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {entries.length === 0 && !editing && !loading && <div className="card-meta">No MCP servers configured in this directory.</div>}

      {entries.map((entry) => {
        const isCollapsed = collapsedServers[entry.name] ?? true;
        return (
          <div key={entry.name} className="card" style={{ marginBottom: 8 }}>
            <div className="card-header">
              <div className="inline-row" style={{ gap: 6 }}>
                <button
                  className="button ghost small"
                  onClick={() => setCollapsedServers((prev) => ({ ...prev, [entry.name]: !(prev[entry.name] ?? true) }))}
                  title={isCollapsed ? "Expand" : "Collapse"}
                  style={{ padding: "2px 4px" }}
                >
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
                <span className="card-title">{entry.name}</span>
              </div>
              <div className="card-header-pills">
                <span className="pill accent">{(entry.config as { type?: string }).type ?? "unknown"}</span>
                <button className="button ghost small" onClick={() => remove(entry.name)} title="Remove" style={{ padding: "2px 4px" }}>
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
            {!isCollapsed && (
              <pre className="code-block" style={{ marginTop: 4, fontSize: 10 }}>
                {formatJson(entry.config)}
              </pre>
            )}
          </div>
        );
      })}
    </>
  );
};

export default McpTab;
