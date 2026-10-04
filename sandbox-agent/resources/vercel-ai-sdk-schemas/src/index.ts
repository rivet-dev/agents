import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, appendFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createGenerator, type Config } from "ts-json-schema-generator";
import { maxSatisfying, rsort, valid } from "semver";
import { x as extractTar } from "tar";
import type { JSONSchema7 } from "json-schema";
import { fetchWithCache } from "./cache.js";

const REGISTRY_URL = "https://registry.npmjs.org/ai";
const TARGET_TYPE = "UIMessage";
const DEFAULT_MAJOR = 6;
const RESOURCE_DIR = join(import.meta.dirname, "..");
const OUTPUT_DIR = join(RESOURCE_DIR, "artifacts", "json-schema");
const OUTPUT_PATH = join(OUTPUT_DIR, "ui-message.json");
const SCHEMA_ID = "https://sandbox-agent/schemas/vercel-ai-sdk/ui-message.json";

interface RegistryResponse {
  versions?: Record<
    string,
    {
      dist?: { tarball?: string };
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    }
  >;
  "dist-tags"?: Record<string, string>;
}

interface Args {
  version: string | null;
  major: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const versionArg = args.find((arg) => arg.startsWith("--version="));
  const majorArg = args.find((arg) => arg.startsWith("--major="));

  const version = versionArg ? versionArg.split("=")[1] : null;
  const major = majorArg ? Number(majorArg.split("=")[1]) : DEFAULT_MAJOR;

  return {
    version,
    major: Number.isFinite(major) && major > 0 ? major : DEFAULT_MAJOR,
  };
}

function log(message: string): void {
  console.log(message);
}

function ensureOutputDir(): void {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

async function fetchRegistry(url: string): Promise<RegistryResponse> {
  const registry = await fetchWithCache(url);
  return JSON.parse(registry) as RegistryResponse;
}

function resolveLatestVersion(registry: RegistryResponse, major: number): string {
  const versions = Object.keys(registry.versions ?? {});
  const candidates = versions.filter((version) => valid(version) && version.startsWith(`${major}.`));
  const sorted = rsort(candidates);
  if (sorted.length === 0) {
    throw new Error(`No versions found for major ${major}`);
  }
  return sorted[0];
}

function resolveVersionFromRange(registry: RegistryResponse, range: string): string {
  if (registry.versions?.[range]) {
    return range;
  }

  const versions = Object.keys(registry.versions ?? {}).filter((version) => valid(version));
  const resolved = maxSatisfying(versions, range);
  if (!resolved) {
    throw new Error(`No versions satisfy range ${range}`);
  }

  return resolved;
}

async function downloadTarball(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download tarball: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(destination, buffer);
}

async function extractPackage(tarballPath: string, targetDir: string): Promise<void> {
  mkdirSync(targetDir, { recursive: true });
  await extractTar({
    file: tarballPath,
    cwd: targetDir,
    strip: 1,
  });
}

function packageDirFor(name: string, nodeModulesDir: string): string {
  const parts = name.split("/");
  return join(nodeModulesDir, ...parts);
}

async function installPackage(name: string, versionRange: string, nodeModulesDir: string, installed: Set<string>): Promise<void> {
  const encodedName = name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  const registryUrl = `https://registry.npmjs.org/${encodedName}`;
  const registry = await fetchRegistry(registryUrl);
  const version = resolveVersionFromRange(registry, versionRange);
  const installKey = `${name}@${version}`;

  if (installed.has(installKey)) {
    return;
  }

  installed.add(installKey);

  const tarball = registry.versions?.[version]?.dist?.tarball;
  if (!tarball) {
    throw new Error(`No tarball found for ${installKey}`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), "vercel-ai-sdk-dep-"));
  const tarballPath = join(tempDir, `${name.replace("/", "-")}-${version}.tgz`);
  const packageDir = packageDirFor(name, nodeModulesDir);

  try {
    await downloadTarball(tarball, tarballPath);
    await extractPackage(tarballPath, packageDir);

    const packageJsonPath = join(packageDir, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.peerDependencies,
    };

    for (const [depName, depRange] of Object.entries(dependencies)) {
      await installPackage(depName, depRange, nodeModulesDir, installed);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeTempTsconfig(tempDir: string): string {
  const tsconfigPath = join(tempDir, "tsconfig.json");
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
    },
  };
  writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
  return tsconfigPath;
}

function writeEntryFile(tempDir: string): string {
  const entryPath = join(tempDir, "entry.ts");
  const contents = `import type { ${TARGET_TYPE} as AI${TARGET_TYPE} } from "ai";\nexport type ${TARGET_TYPE} = AI${TARGET_TYPE};\n`;
  writeFileSync(entryPath, contents);
  return entryPath;
}

function patchValueOfAlias(nodeModulesDir: string): void {
  const aiTypesPath = join(nodeModulesDir, "ai", "dist", "index.d.ts");
  if (!existsSync(aiTypesPath)) {
    log("  [warn] ai types not found for ValueOf patch");
    return;
  }

  const contents = readFileSync(aiTypesPath, "utf-8");
  const valueOfMatch = contents.match(/type ValueOf[\\s\\S]*?;/);
  if (valueOfMatch) {
    const snippet = valueOfMatch[0].replace(/\\s+/g, " ").slice(0, 200);
    log(`  [debug] ValueOf alias snippet: ${snippet}`);
  } else {
    log("  [warn] ValueOf alias declaration not found");
  }

  let patched = contents.replace(/ObjectType\\s*\\[\\s*ValueType\\s*\\]/, "ObjectType[string]");

  if (patched !== contents) {
    writeFileSync(aiTypesPath, patched);
    log("  [patch] Adjusted ValueOf alias for schema generation");
    return;
  }

  const valueOfIndex = contents.indexOf("ValueOf");
  const preview = valueOfIndex === -1 ? contents.slice(0, 200) : contents.slice(valueOfIndex, valueOfIndex + 200);
  log("  [warn] ValueOf alias not found in ai types");
  log(`  [debug] ai types path: ${aiTypesPath}`);
  log(`  [debug] preview: ${preview.replace(/\\s+/g, " ").slice(0, 200)}`);
}

function ensureTypeFestShim(nodeModulesDir: string): void {
  const typeFestDir = join(nodeModulesDir, "type-fest");
  if (!existsSync(typeFestDir)) {
    mkdirSync(typeFestDir, { recursive: true });
  }

  const packageJsonPath = join(typeFestDir, "package.json");
  const typesPath = join(typeFestDir, "index.d.ts");

  if (!existsSync(packageJsonPath)) {
    const pkg = {
      name: "type-fest",
      version: "0.0.0",
      types: "index.d.ts",
    };
    writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2));
  }

  const shim = `export type ValueOf<\n  ObjectType,\n  ValueType extends keyof ObjectType = keyof ObjectType,\n> = ObjectType[string];\n\nexport type Simplify<T> = { [KeyType in keyof T]: T[KeyType] } & {};\n`;
  writeFileSync(typesPath, shim);
  log("  [shim] Wrote type-fest ValueOf shim");
}

function generateSchema(entryPath: string, tsconfigPath: string): JSONSchema7 {
  const config: Config = {
    path: entryPath,
    tsconfig: tsconfigPath,
    type: TARGET_TYPE,
    expose: "export",
    skipTypeCheck: true,
  };

  const generator = createGenerator(config);
  return generator.createSchema(TARGET_TYPE) as JSONSchema7;
}

function addSchemaMetadata(schema: JSONSchema7, version: string): JSONSchema7 {
  const withMeta: JSONSchema7 = {
    ...schema,
    $schema: schema.$schema ?? "http://json-schema.org/draft-07/schema#",
    $id: SCHEMA_ID,
    title: schema.title ?? TARGET_TYPE,
    description: schema.description ?? `Vercel AI SDK v${version} ${TARGET_TYPE}`,
  };

  return withMeta;
}

function loadFallback(): JSONSchema7 | null {
  if (!existsSync(OUTPUT_PATH)) {
    return null;
  }

  try {
    const content = readFileSync(OUTPUT_PATH, "utf-8");
    return JSON.parse(content) as JSONSchema7;
  } catch {
    return null;
  }
}

function patchUiMessageTypes(nodeModulesDir: string): void {
  const aiTypesPath = join(nodeModulesDir, "ai", "dist", "index.d.ts");
  if (!existsSync(aiTypesPath)) {
    log("  [warn] ai types not found for UIMessage patch");
    return;
  }

  const contents = readFileSync(aiTypesPath, "utf-8");
  let patched = contents;

  const replaceAlias = (typeName: string, replacement: string): boolean => {
    const start = patched.indexOf(`type ${typeName}`);
    if (start === -1) {
      log(`  [warn] ${typeName} alias not found for patch`);
      return false;
    }
    const end = patched.indexOf(";", start);
    if (end === -1) {
      log(`  [warn] ${typeName} alias not terminated`);
      return false;
    }
    const snippet = patched.slice(start, Math.min(end + 1, start + 400)).replace(/\\s+/g, " ");
    log(`  [debug] ${typeName} alias snippet: ${snippet}`);

    patched = patched.slice(0, start) + replacement + patched.slice(end + 1);
    return true;
  };

  const dataReplaced = replaceAlias(
    "DataUIPart",
    "type DataUIPart<DATA_TYPES extends UIDataTypes> = {\\n    type: `data-${string}`;\\n    id?: string;\\n    data: unknown;\\n};",
  );
  if (dataReplaced) {
    log("  [patch] Simplified DataUIPart to avoid indexed access");
  }

  const toolReplaced = replaceAlias(
    "ToolUIPart",
    "type ToolUIPart<TOOLS extends UITools = UITools> = {\\n    type: `tool-${string}`;\\n} & UIToolInvocation<UITool>;",
  );
  if (toolReplaced) {
    log("  [patch] Simplified ToolUIPart to avoid indexed access");
  }

  if (patched !== contents) {
    writeFileSync(aiTypesPath, patched);
  }
}

async function main(): Promise<void> {
  log("Vercel AI SDK UIMessage Schema Extractor");
  log("========================================\n");

  const args = parseArgs();
  ensureOutputDir();

  const registry = await fetchRegistry(REGISTRY_URL);
  const version = args.version ?? resolveLatestVersion(registry, args.major);

  log(`Target version: ai@${version}`);

  const tempDir = mkdtempSync(join(tmpdir(), "vercel-ai-sdk-"));
  const nodeModulesDir = join(tempDir, "node_modules");

  try {
    log(`  [debug] temp dir: ${tempDir}`);
    await installPackage("ai", version, nodeModulesDir, new Set());
    ensureTypeFestShim(nodeModulesDir);
    patchUiMessageTypes(nodeModulesDir);
    patchValueOfAlias(nodeModulesDir);

    const tsconfigPath = writeTempTsconfig(tempDir);
    const entryPath = writeEntryFile(tempDir);
    log(`  [debug] entry path: ${entryPath}`);
    log(`  [debug] tsconfig path: ${tsconfigPath}`);
    if (existsSync(entryPath)) {
      const entryStat = statSync(entryPath);
      log(`  [debug] entry size: ${entryStat.size}`);
    }

    const schema = generateSchema(entryPath, tsconfigPath);
    const schemaWithMeta = addSchemaMetadata(schema, version);

    writeFileSync(OUTPUT_PATH, JSON.stringify(schemaWithMeta, null, 2));
    log(`\n  [wrote] ${OUTPUT_PATH}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`\n  [error] ${message}`);
    if (error instanceof Error && error.stack) {
      log(error.stack);
    }

    const fallback = loadFallback();
    if (fallback) {
      log("  [fallback] Keeping existing schema artifact");
      return;
    }

    process.exitCode = 1;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
