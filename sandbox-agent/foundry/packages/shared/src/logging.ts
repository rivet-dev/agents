import { pino, type LogFn, type Logger, type LoggerOptions } from "pino";

export interface FoundryLoggerOptions {
  service: string;
  bindings?: Record<string, unknown>;
  level?: string;
  format?: "json" | "logfmt";
}

type ProcessLike = {
  env?: Record<string, string | undefined>;
  stdout?: {
    write?: (chunk: string) => unknown;
  };
};

function resolveEnvVar(name: string): string | undefined {
  const value = (globalThis as { process?: ProcessLike }).process?.env?.[name];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function defaultLevel(): string {
  return resolveEnvVar("FOUNDRY_LOG_LEVEL") ?? resolveEnvVar("LOG_LEVEL") ?? resolveEnvVar("RIVET_LOG_LEVEL") ?? "info";
}

function isBrowserRuntime(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function serializeLogValue(value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Error) {
    return JSON.stringify({
      name: value.name,
      message: value.message,
      stack: value.stack,
    });
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function formatLogfmtValue(value: string | number | boolean | null): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  const raw = value ?? "null";
  if (raw.length > 0 && !/[\s="\\]/.test(raw)) {
    return raw;
  }

  return `"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function formatLogfmtLine(record: Record<string, unknown>): string {
  return Object.entries(record)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatLogfmtValue(serializeLogValue(value))}`)
    .join(" ");
}

function stringifyMessagePart(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  const serialized = serializeLogValue(value);
  return typeof serialized === "string" ? serialized : String(serialized);
}

function buildLogRecord(level: string, bindings: Record<string, unknown>, args: Parameters<Logger["info"]>): Record<string, unknown> {
  const record: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
  };

  for (const [key, value] of Object.entries(bindings)) {
    if (key !== "time" && key !== "level" && key !== "msg" && value !== undefined) {
      record[key] = value;
    }
  }

  if (args.length === 0) {
    return record;
  }

  const [first, ...rest] = args;
  if (first && typeof first === "object") {
    if (first instanceof Error) {
      record.err = {
        name: first.name,
        message: first.message,
        stack: first.stack,
      };
    } else {
      for (const [key, value] of Object.entries(first)) {
        if (key !== "time" && key !== "level" && key !== "msg" && value !== undefined) {
          record[key] = value;
        }
      }
    }

    if (rest.length > 0) {
      record.msg = rest.map(stringifyMessagePart).join(" ");
    }

    return record;
  }

  record.msg = [first, ...rest].map(stringifyMessagePart).join(" ");
  return record;
}

function writeLogfmtLine(line: string): void {
  const processLike = (globalThis as { process?: ProcessLike }).process;
  if (processLike?.stdout?.write) {
    processLike.stdout.write(`${line}\n`);
    return;
  }

  console.log(line);
}

export function createFoundryLogger(options: FoundryLoggerOptions): Logger {
  const browser = isBrowserRuntime();
  const loggerOptions: LoggerOptions = {
    level: options.level ?? defaultLevel(),
    base: {
      service: options.service,
      ...(options.bindings ?? {}),
    },
  };

  if (browser) {
    loggerOptions.browser = {
      asObject: true,
    };
  } else {
    loggerOptions.timestamp = pino.stdTimeFunctions.isoTime;
    if (options.format === "logfmt") {
      loggerOptions.hooks = {
        logMethod(this: Logger, args: Parameters<LogFn>, _method: LogFn, level: number) {
          const levelLabel = this.levels.labels[level] ?? "info";
          const record = buildLogRecord(levelLabel, this.bindings(), args);
          writeLogfmtLine(formatLogfmtLine(record));
        },
      };
    }
  }

  return pino(loggerOptions);
}

export function createErrorContext(error: unknown): { errorMessage: string; errorStack?: string } {
  if (error instanceof Error) {
    return {
      errorMessage: error.message,
      errorStack: error.stack,
    };
  }

  return {
    errorMessage: String(error),
  };
}
