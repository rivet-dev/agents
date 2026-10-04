import type { AppConfig, TaskRecord, WorkspaceTaskDetail } from "@sandbox-agent/foundry-shared";
import { spawnSync } from "node:child_process";
import { createBackendClientFromConfig, filterTasks, formatRelativeAge, groupTaskStatus } from "@sandbox-agent/foundry-client";
import { CLI_BUILD_ID } from "./build-id.js";
import { writeStdout } from "./io.js";
import { resolveTuiTheme, type TuiTheme } from "./theme.js";

interface KeyEventLike {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
}

const HELP_LINES = [
  "Shortcuts",
  "Ctrl-H           toggle cheatsheet",
  "Enter            switch to branch",
  "Ctrl-A           attach to session",
  "Ctrl-O           open PR in browser",
  "Ctrl-X           archive branch / close PR",
  "Ctrl-Y           merge highlighted PR",
  "Ctrl-S           sync task with remote",
  "Ctrl-N / Down    next row",
  "Ctrl-P / Up      previous row",
  "Backspace        delete filter",
  "Type             filter by branch/PR/author",
  "Esc / Ctrl-C     cancel",
  "",
  "Legend",
  "Agent: \u{1F916} running  \u{1F4AC} idle  \u25CC queued",
];

const COLUMN_WIDTHS = {
  diff: 10,
  agent: 5,
  pr: 6,
  author: 10,
  ci: 7,
  review: 8,
  age: 5,
} as const;

interface DisplayRow {
  name: string;
  diff: string;
  agent: string;
  pr: string;
  author: string;
  ci: string;
  review: string;
  age: string;
}

type TuiTaskRow = TaskRecord & Pick<WorkspaceTaskDetail, "pullRequest"> & { activeSessionId?: string | null };

interface RenderOptions {
  width?: number;
  height?: number;
}

async function listDetailedTasks(client: ReturnType<typeof createBackendClientFromConfig>, organizationId: string): Promise<TuiTaskRow[]> {
  const rows = await client.listTasks(organizationId);
  return await Promise.all(
    rows.map(async (row) => {
      const [task, detail] = await Promise.all([
        client.getTask(organizationId, row.repoId, row.taskId),
        client.getTaskDetail(organizationId, row.repoId, row.taskId).catch(() => null),
      ]);
      return {
        ...task,
        pullRequest: detail?.pullRequest ?? null,
        activeSessionId: detail?.activeSessionId ?? null,
      };
    }),
  );
}

function pad(input: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  const chars = Array.from(input);
  const text = chars.length > width ? `${chars.slice(0, Math.max(1, width - 1)).join("")}…` : input;
  return text.padEnd(width, " ");
}

function truncateToLen(input: string, maxLen: number): string {
  if (maxLen <= 0) {
    return "";
  }
  return Array.from(input).slice(0, maxLen).join("");
}

function fitLine(input: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  const clipped = truncateToLen(input, width);
  const len = Array.from(clipped).length;
  if (len >= width) {
    return clipped;
  }
  return `${clipped}${" ".repeat(width - len)}`;
}

function overlayLine(base: string, overlay: string, startCol: number, width: number): string {
  const out = Array.from(fitLine(base, width));
  const src = Array.from(truncateToLen(overlay, Math.max(0, width - startCol)));
  for (let i = 0; i < src.length; i += 1) {
    const col = startCol + i;
    if (col >= 0 && col < out.length) {
      out[col] = src[i] ?? " ";
    }
  }
  return out.join("");
}

function buildFooterLine(width: number, segments: string[], right: string): string {
  if (width <= 0) {
    return "";
  }

  const rightLen = Array.from(right).length;
  if (width <= rightLen + 1) {
    return truncateToLen(right, width);
  }

  const leftMax = width - rightLen - 1;
  let used = 0;
  let left = "";
  let first = true;

  for (const segment of segments) {
    const chunk = first ? segment : ` | ${segment}`;
    const clipped = truncateToLen(chunk, leftMax - used);
    if (!clipped) {
      break;
    }
    left += clipped;
    used += Array.from(clipped).length;
    first = false;
    if (used >= leftMax) {
      break;
    }
  }

  const padding = " ".repeat(Math.max(0, leftMax - used) + 1);
  return `${left}${padding}${right}`;
}

function agentSymbol(status: TaskRecord["status"]): string {
  const group = groupTaskStatus(status);
  if (group === "running") return "🤖";
  if (group === "idle") return "💬";
  if (group === "error") return "⚠";
  if (group === "queued") return "◌";
  return "-";
}

function toDisplayRow(row: TuiTaskRow): DisplayRow {
  const prLabel = row.pullRequest ? `#${row.pullRequest.number}` : "-";
  const reviewLabel = row.pullRequest ? (row.pullRequest.isDraft ? "draft" : row.pullRequest.state.toLowerCase()) : "-";

  return {
    name: row.title || row.branchName || row.taskId,
    diff: "-",
    agent: agentSymbol(row.status),
    pr: prLabel,
    author: row.pullRequest?.authorLogin ?? "-",
    ci: "-",
    review: reviewLabel,
    age: formatRelativeAge(row.updatedAt),
  };
}

function helpLines(width: number): string[] {
  const popupWidth = Math.max(40, Math.min(width - 2, 100));
  const innerWidth = Math.max(2, popupWidth - 2);
  const borderTop = `┌${"─".repeat(innerWidth)}┐`;
  const borderBottom = `└${"─".repeat(innerWidth)}┘`;

  const lines = [borderTop];
  for (const line of HELP_LINES) {
    lines.push(`│${pad(line, innerWidth)}│`);
  }
  lines.push(borderBottom);
  return lines;
}

export function formatRows(
  rows: TuiTaskRow[],
  selected: number,
  organizationId: string,
  status: string,
  searchQuery = "",
  showHelp = false,
  options: RenderOptions = {},
): string {
  const totalWidth = options.width ?? process.stdout.columns ?? 120;
  const totalHeight = Math.max(6, options.height ?? process.stdout.rows ?? 24);
  const fixedWidth =
    COLUMN_WIDTHS.diff + COLUMN_WIDTHS.agent + COLUMN_WIDTHS.pr + COLUMN_WIDTHS.author + COLUMN_WIDTHS.ci + COLUMN_WIDTHS.review + COLUMN_WIDTHS.age;
  const separators = 7;
  const prefixWidth = 2;
  const branchWidth = Math.max(20, totalWidth - (fixedWidth + separators + prefixWidth));

  const branchHeader = searchQuery ? `Branch/PR: ${searchQuery}_` : "Branch/PR (type to filter)";
  const header = [
    `  ${pad(branchHeader, branchWidth)} ${pad("Diff", COLUMN_WIDTHS.diff)} ${pad("Agent", COLUMN_WIDTHS.agent)} ${pad("PR", COLUMN_WIDTHS.pr)} ${pad("Author", COLUMN_WIDTHS.author)} ${pad("CI", COLUMN_WIDTHS.ci)} ${pad("Review", COLUMN_WIDTHS.review)} ${pad("Age", COLUMN_WIDTHS.age)}`,
    "-".repeat(Math.max(24, Math.min(totalWidth, 180))),
  ];

  const body =
    rows.length === 0
      ? ["No branches found."]
      : rows.map((row, index) => {
          const marker = index === selected ? "┃ " : "  ";
          const display = toDisplayRow(row);
          return `${marker}${pad(display.name, branchWidth)} ${pad(display.diff, COLUMN_WIDTHS.diff)} ${pad(display.agent, COLUMN_WIDTHS.agent)} ${pad(display.pr, COLUMN_WIDTHS.pr)} ${pad(display.author, COLUMN_WIDTHS.author)} ${pad(display.ci, COLUMN_WIDTHS.ci)} ${pad(display.review, COLUMN_WIDTHS.review)} ${pad(display.age, COLUMN_WIDTHS.age)}`;
        });

  const footer = fitLine(buildFooterLine(totalWidth, ["Ctrl-H:cheatsheet", `organization:${organizationId}`, status], `v${CLI_BUILD_ID}`), totalWidth);

  const contentHeight = totalHeight - 1;
  const lines = [...header, ...body].map((line) => fitLine(line, totalWidth));
  const page = lines.slice(0, contentHeight);
  while (page.length < contentHeight) {
    page.push(" ".repeat(totalWidth));
  }

  if (showHelp) {
    const popup = helpLines(totalWidth);
    const startRow = Math.max(0, Math.floor((contentHeight - popup.length) / 2));
    for (let i = 0; i < popup.length; i += 1) {
      const target = startRow + i;
      if (target >= page.length) {
        break;
      }
      const popupLine = popup[i] ?? "";
      const popupLen = Array.from(popupLine).length;
      const startCol = Math.max(0, Math.floor((totalWidth - popupLen) / 2));
      page[target] = overlayLine(page[target] ?? "", popupLine, startCol, totalWidth);
    }
  }

  return [...page, footer].join("\n");
}

interface OpenTuiLike {
  createCliRenderer?: (options?: Record<string, unknown>) => Promise<any>;
  TextRenderable?: new (
    ctx: any,
    options: { id: string; content: string },
  ) => {
    content: unknown;
    fg?: string;
    bg?: string;
  };
  fg?: (color: string) => (input: unknown) => unknown;
  bg?: (color: string) => (input: unknown) => unknown;
  StyledText?: new (chunks: unknown[]) => unknown;
}

interface StyledTextApi {
  fg: (color: string) => (input: unknown) => unknown;
  bg: (color: string) => (input: unknown) => unknown;
  StyledText: new (chunks: unknown[]) => unknown;
}

function buildStyledContent(content: string, theme: TuiTheme, api: StyledTextApi): unknown {
  const lines = content.split("\n");
  const chunks: unknown[] = [];
  const footerIndex = Math.max(0, lines.length - 1);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    let fgColor = theme.text;
    let bgColor: string | undefined;

    if (line.startsWith("┃ ")) {
      const marker = "┃ ";
      const rest = line.slice(marker.length);
      bgColor = theme.highlightBg;
      const markerChunk = api.bg(bgColor)(api.fg(theme.selectionBorder)(marker));
      const restChunk = api.bg(bgColor)(api.fg(theme.highlightFg)(rest));
      chunks.push(markerChunk);
      chunks.push(restChunk);
      if (i < lines.length - 1) {
        chunks.push(api.fg(theme.text)("\n"));
      }
      continue;
    }

    if (i === 0) {
      fgColor = theme.header;
    } else if (i === 1) {
      fgColor = theme.muted;
    } else if (i === footerIndex) {
      fgColor = theme.status;
    } else if (line.startsWith("┌") || line.startsWith("│") || line.startsWith("└")) {
      fgColor = theme.info;
    }

    let chunk: unknown = api.fg(fgColor)(line);
    if (bgColor) {
      chunk = api.bg(bgColor)(chunk);
    }
    chunks.push(chunk);

    if (i < lines.length - 1) {
      chunks.push(api.fg(theme.text)("\n"));
    }
  }

  return new api.StyledText(chunks);
}

export async function runTui(config: AppConfig, organizationId: string): Promise<void> {
  const core = (await import("@opentui/core")) as OpenTuiLike;
  const createCliRenderer = core.createCliRenderer;
  const TextRenderable = core.TextRenderable;
  const styleApi = core.fg && core.bg && core.StyledText ? { fg: core.fg, bg: core.bg, StyledText: core.StyledText } : null;

  if (!createCliRenderer || !TextRenderable) {
    throw new Error("OpenTUI runtime missing createCliRenderer/TextRenderable exports");
  }

  const themeResolution = resolveTuiTheme(config);
  const client = createBackendClientFromConfig(config);
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const text = new TextRenderable(renderer, {
    id: "foundry-switch",
    content: "Loading...",
  });
  text.fg = themeResolution.theme.text;
  text.bg = themeResolution.theme.background;
  renderer.root.add(text);
  renderer.start();

  let allRows: TuiTaskRow[] = [];
  let filteredRows: TuiTaskRow[] = [];
  let selected = 0;
  let searchQuery = "";
  let showHelp = false;
  let status = "loading...";
  let busy = false;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const clampSelected = (): void => {
    if (filteredRows.length === 0) {
      selected = 0;
      return;
    }
    if (selected < 0) {
      selected = 0;
      return;
    }
    if (selected >= filteredRows.length) {
      selected = filteredRows.length - 1;
    }
  };

  const render = (): void => {
    if (closed) {
      return;
    }
    const output = formatRows(filteredRows, selected, organizationId, status, searchQuery, showHelp, {
      width: renderer.width ?? process.stdout.columns,
      height: renderer.height ?? process.stdout.rows,
    });
    text.content = styleApi ? buildStyledContent(output, themeResolution.theme, styleApi) : output;
    renderer.requestRender();
  };

  const refresh = async (): Promise<void> => {
    if (closed) {
      return;
    }
    try {
      allRows = await listDetailedTasks(client, organizationId);
      if (closed) {
        return;
      }
      filteredRows = filterTasks(allRows, searchQuery);
      clampSelected();
      status = `tasks=${allRows.length} filtered=${filteredRows.length}`;
    } catch (err) {
      if (closed) {
        return;
      }
      status = err instanceof Error ? err.message : String(err);
    }
    render();
  };

  const selectedRow = (): TuiTaskRow | null => {
    if (filteredRows.length === 0) {
      return null;
    }
    return filteredRows[selected] ?? null;
  };

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = () => resolve();
  });

  const close = (output?: string): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    renderer.destroy();
    if (output) {
      writeStdout(output);
    }
    resolveDone();
  };

  const handleSignal = (): void => {
    close();
  };

  const runActionWithRefresh = async (label: string, fn: () => Promise<void>, success: string): Promise<void> => {
    if (busy) {
      return;
    }
    busy = true;
    status = `${label}...`;
    render();
    try {
      await fn();
      status = success;
      await refresh();
    } catch (err) {
      status = err instanceof Error ? err.message : String(err);
      render();
    } finally {
      busy = false;
    }
  };

  await refresh();
  timer = setInterval(() => {
    void refresh();
  }, 10_000);
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  const keyInput = (renderer.keyInput ?? renderer.keyHandler) as { on: (name: string, cb: (event: KeyEventLike) => void) => void } | undefined;

  if (!keyInput) {
    clearInterval(timer);
    renderer.destroy();
    throw new Error("OpenTUI key input handler is unavailable");
  }

  keyInput.on("keypress", (event: KeyEventLike) => {
    if (closed) {
      return;
    }

    const name = event.name ?? "";
    const ctrl = Boolean(event.ctrl);

    if (ctrl && name === "h") {
      showHelp = !showHelp;
      render();
      return;
    }

    if (showHelp) {
      if (name === "escape") {
        showHelp = false;
        render();
      }
      return;
    }

    if (name === "q" || name === "escape" || (ctrl && name === "c")) {
      close();
      return;
    }

    if ((ctrl && name === "n") || name === "down") {
      if (filteredRows.length > 0) {
        selected = selected >= filteredRows.length - 1 ? 0 : selected + 1;
        render();
      }
      return;
    }

    if ((ctrl && name === "p") || name === "up") {
      if (filteredRows.length > 0) {
        selected = selected <= 0 ? filteredRows.length - 1 : selected - 1;
        render();
      }
      return;
    }

    if (name === "backspace") {
      searchQuery = searchQuery.slice(0, -1);
      filteredRows = filterTasks(allRows, searchQuery);
      selected = 0;
      render();
      return;
    }

    if (name === "return" || name === "enter") {
      const row = selectedRow();
      if (!row || busy) {
        return;
      }
      busy = true;
      status = `switching ${row.taskId}...`;
      render();
      void (async () => {
        try {
          const result = await client.switchTask(organizationId, row.repoId, row.taskId);
          close(`cd ${result.switchTarget}`);
        } catch (err) {
          busy = false;
          status = err instanceof Error ? err.message : String(err);
          render();
        }
      })();
      return;
    }

    if (ctrl && name === "a") {
      const row = selectedRow();
      if (!row || busy) {
        return;
      }
      busy = true;
      status = `attaching ${row.taskId}...`;
      render();
      void (async () => {
        try {
          const result = await client.attachTask(organizationId, row.repoId, row.taskId);
          close(`target=${result.target} session=${result.sessionId ?? "none"}`);
        } catch (err) {
          busy = false;
          status = err instanceof Error ? err.message : String(err);
          render();
        }
      })();
      return;
    }

    if (ctrl && name === "x") {
      const row = selectedRow();
      if (!row) {
        return;
      }
      void runActionWithRefresh(
        `archiving ${row.taskId}`,
        async () => client.runAction(organizationId, row.repoId, row.taskId, "archive"),
        `archived ${row.taskId}`,
      );
      return;
    }

    if (ctrl && name === "s") {
      const row = selectedRow();
      if (!row) {
        return;
      }
      void runActionWithRefresh(`syncing ${row.taskId}`, async () => client.runAction(organizationId, row.repoId, row.taskId, "sync"), `synced ${row.taskId}`);
      return;
    }

    if (ctrl && name === "y") {
      const row = selectedRow();
      if (!row) {
        return;
      }
      void runActionWithRefresh(
        `merging ${row.taskId}`,
        async () => {
          await client.runAction(organizationId, row.repoId, row.taskId, "merge");
          await client.runAction(organizationId, row.repoId, row.taskId, "archive");
        },
        `merged+archived ${row.taskId}`,
      );
      return;
    }

    if (ctrl && name === "o") {
      const row = selectedRow();
      const prUrl = row?.pullRequest?.url ?? null;
      if (!prUrl) {
        status = "no PR URL available for this task";
        render();
        return;
      }
      const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
      spawnSync(openCmd, [prUrl], { stdio: "ignore" });
      status = `opened ${prUrl}`;
      render();
      return;
    }

    if (!ctrl && !event.meta && name.length === 1) {
      searchQuery += name;
      filteredRows = filterTasks(allRows, searchQuery);
      selected = 0;
      render();
    }
  });

  await done;
}
