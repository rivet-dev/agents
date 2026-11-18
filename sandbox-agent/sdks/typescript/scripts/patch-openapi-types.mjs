import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(process.cwd(), "src/generated/openapi.ts");
let source = readFileSync(target, "utf8");

const replacements = [
  ['components["schemas"]["McpCommand"]', "string"],
  ['components["schemas"]["McpOAuthConfigOrDisabled"]', "Record<string, unknown> | null"],
  ['components["schemas"]["McpRemoteTransport"]', "string"],
];

for (const [from, to] of replacements) {
  source = source.split(from).join(to);
}

writeFileSync(target, source);
