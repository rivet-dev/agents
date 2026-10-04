import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

async function main() {
  const server = new McpServer({ name: "rand", version: "1.0.0" });

  server.tool(
    "random_number",
    "Generate a random integer between min and max (inclusive)",
    {
      min: z.number().describe("Minimum value"),
      max: z.number().describe("Maximum value"),
    },
    async ({ min, max }) => ({
      content: [{ type: "text", text: String(Math.floor(Math.random() * (max - min + 1)) + min) }],
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
