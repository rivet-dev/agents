import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

// One folder per skill, next to this file: skills/<name>/SKILL.md.
const root = join(import.meta.dirname, "skills");
const skills = new Map<string, { description: string; body: string }>();
for (const folder of await readdir(root, { withFileTypes: true })) {
	if (!folder.isDirectory()) continue;
	const file = await readFile(join(root, folder.name, "SKILL.md"), "utf8");
	const { frontmatter, body } = parseFrontmatter<{ name?: string; description?: string }>(file);
	skills.set(frontmatter.name ?? folder.name, { description: frontmatter.description ?? "", body });
}

const loadSkill = defineTool({
	name: "skill",
	description: "Load a skill's instructions by name.",
	parameters: Type.Object({ name: Type.String() }),
	// Reading a skill changes nothing, so running it twice is harmless.
	replay: "safe",
	execute: async ({ name }) => {
		const skill = skills.get(name);
		if (!skill) throw new Error(`No skill named ${name}. Skills: ${[...skills.keys()].join(", ")}.`);
		return { content: [{ type: "text", text: skill.body }] };
	},
});

export const Skills = defineExtension({
	name: "skills",
	tools: [loadSkill],
	sections: [
		// The model sees every skill's name and description. It loads a skill's instructions only when it needs them.
		section("skills", () =>
			[
				"Skills hold instructions for specific tasks. Before you start a task that matches a skill's description, call the `skill` tool with its name and follow what it returns.",
				...[...skills].map(([name, { description }]) => `- ${name}: ${description}`),
			].join("\n"),
		),
	],
});
