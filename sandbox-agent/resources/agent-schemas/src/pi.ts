import { execSync } from "child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createGenerator, type Config } from "ts-json-schema-generator";
import { createNormalizedSchema, type NormalizedSchema } from "./normalize.js";
import type { JSONSchema7 } from "json-schema";

const PI_SOURCE_URL = "https://codeload.github.com/badlogic/pi-mono/tar.gz/refs/heads/main";
const RPC_TYPES_PATH = "packages/coding-agent/src/modes/rpc/rpc-types.ts";
const TARGET_TYPES = ["RpcEvent", "RpcResponse", "RpcCommand"] as const;

export async function extractPiSchema(): Promise<NormalizedSchema> {
  console.log("Extracting Pi schema from pi-mono sources...");

  const tempDir = mkdtempSync(join(tmpdir(), "pi-schema-"));
  try {
    const archivePath = join(tempDir, "pi-mono.tar.gz");
    await downloadToFile(PI_SOURCE_URL, archivePath);

    execSync(`tar -xzf "${archivePath}" -C "${tempDir}"`, {
      stdio: ["ignore", "ignore", "ignore"],
    });

    const repoRoot = findRepoRoot(tempDir);
    const rpcTypesPath = join(repoRoot, RPC_TYPES_PATH);
    if (!existsSync(rpcTypesPath)) {
      throw new Error(`rpc-types.ts not found at ${rpcTypesPath}`);
    }

    const tsconfig = resolveTsconfig(repoRoot);
    const definitions = generateDefinitions(rpcTypesPath, tsconfig);
    if (Object.keys(definitions).length === 0) {
      console.log("  [warn] No schemas extracted from source, using fallback");
      return createFallbackSchema();
    }

    console.log(`  [ok] Extracted ${Object.keys(definitions).length} types from source`);
    return createNormalizedSchema("pi", "Pi RPC Schema", definitions);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log(`  [warn] Pi schema extraction failed: ${errorMessage}`);
    console.log("  [fallback] Using embedded schema definitions");
    return createFallbackSchema();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function downloadToFile(url: string, filePath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(filePath, buffer);
}

function findRepoRoot(root: string): string {
  const entries = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const repoDir = entries.find((entry) => entry.name.startsWith("pi-mono"));
  if (!repoDir) {
    throw new Error("pi-mono source directory not found after extraction");
  }
  return join(root, repoDir.name);
}

function resolveTsconfig(root: string): string | undefined {
  const candidates = [join(root, "tsconfig.json"), join(root, "tsconfig.base.json"), join(root, "packages", "coding-agent", "tsconfig.json")];
  return candidates.find((path) => existsSync(path));
}

function generateDefinitions(rpcTypesPath: string, tsconfigPath?: string): Record<string, JSONSchema7> {
  const definitions: Record<string, JSONSchema7> = {};

  for (const typeName of TARGET_TYPES) {
    const config: Config = {
      path: rpcTypesPath,
      type: typeName,
      expose: "all",
      skipTypeCheck: false,
      topRef: false,
      ...(tsconfigPath ? { tsconfig: tsconfigPath } : {}),
    };
    const schema = createGenerator(config).createSchema(typeName) as JSONSchema7;
    mergeDefinitions(definitions, schema, typeName);
  }

  return definitions;
}

function mergeDefinitions(target: Record<string, JSONSchema7>, schema: JSONSchema7, typeName: string): void {
  if (schema.definitions) {
    for (const [name, def] of Object.entries(schema.definitions)) {
      target[name] = def as JSONSchema7;
    }
  } else if (schema.$defs) {
    for (const [name, def] of Object.entries(schema.$defs)) {
      target[name] = def as JSONSchema7;
    }
  } else {
    target[typeName] = schema;
  }

  if (!target[typeName]) {
    target[typeName] = schema;
  }
}

function createFallbackSchema(): NormalizedSchema {
  const definitions: Record<string, JSONSchema7> = {
    RpcEvent: {
      type: "object",
      properties: {
        type: { type: "string" },
        sessionId: { type: "string" },
        messageId: { type: "string" },
        message: { $ref: "#/definitions/RpcMessage" },
        assistantMessageEvent: { $ref: "#/definitions/AssistantMessageEvent" },
        toolCallId: { type: "string" },
        toolName: { type: "string" },
        args: {},
        partialResult: {},
        result: { $ref: "#/definitions/ToolResult" },
        isError: { type: "boolean" },
        error: {},
      },
      required: ["type"],
    },
    RpcMessage: {
      type: "object",
      properties: {
        role: { type: "string" },
        content: {},
      },
    },
    AssistantMessageEvent: {
      type: "object",
      properties: {
        type: { type: "string" },
        delta: { type: "string" },
        content: {},
        partial: {},
        messageId: { type: "string" },
      },
    },
    ToolResult: {
      type: "object",
      properties: {
        type: { type: "string" },
        content: { type: "string" },
        text: { type: "string" },
      },
    },
    RpcResponse: {
      type: "object",
      properties: {
        type: { type: "string", const: "response" },
        id: { type: "integer" },
        success: { type: "boolean" },
        data: {},
        error: {},
      },
      required: ["type"],
    },
    RpcCommand: {
      type: "object",
      properties: {
        type: { type: "string", const: "command" },
        id: { type: "integer" },
        command: { type: "string" },
        params: {},
      },
      required: ["type", "command"],
    },
  };

  console.log(`  [ok] Using fallback schema with ${Object.keys(definitions).length} definitions`);
  return createNormalizedSchema("pi", "Pi RPC Schema", definitions);
}
