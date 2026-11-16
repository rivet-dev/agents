import type {
	Extension,
	HarnessSettings,
	RegistryReader,
	RegistrySnapshot,
} from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { PiOptions } from "./runtime.js";

/**
 * The app's registry and settings plus `extensions`. Conversations that use
 * the default selection get them: without one every installed extension is
 * selected, and an app selection gets them appended.
 */
export function withExtensions(
	options: { registry: RegistryReader; settings?: HarnessSettings },
	extensions: readonly Extension[],
): { registry: RegistryReader; settings?: HarnessSettings } {
	if (extensions.length === 0) return options;
	let cached:
		| { base: RegistrySnapshot; snapshot: RegistrySnapshot }
		| undefined;
	const registry: RegistryReader = {
		snapshot() {
			const base = options.registry.snapshot();
			if (cached?.base !== base) {
				cached = {
					base,
					snapshot: extensions.reduce(snapshotWith, base),
				};
			}
			return cached.snapshot;
		},
		subscribe: (listener) => options.registry.subscribe(listener),
	};
	const settings =
		options.settings &&
		new Proxy(options.settings, {
			get(target, property, receiver) {
				if (property !== "extensions") {
					return Reflect.get(target, property, receiver);
				}
				return target.extensions && [...target.extensions, ...extensions];
			},
		});
	return { registry, settings };
}

/**
 * The Pi Durable extensions that `pi()` options turn on: Pi's coding tools and
 * tool search. A tool or extension the app's registry already has is not
 * installed again. A sandbox brings the coding tools only when the registry
 * has none of them, so a registry that picked some keeps exactly those.
 */
export function builtInExtensions(
	options: PiOptions,
	registry: RegistryReader,
): Extension[] {
	const installed = registry.snapshot();
	const registered = new Set(installed.tools().map(({ tool }) => tool.name));
	const coding = codingTools(
		options.codingTools ??
			(options.sandbox !== undefined &&
				!CODING_TOOLS.some((tool) => registered.has(tool.name))),
		registered,
	);
	return [
		coding,
		options.toolSearch ? createToolSearchExtension() : undefined,
	].filter(
		(extension): extension is Extension =>
			extension !== undefined && !installed.extension(extension.name),
	);
}

const CODING_TOOLS = CodingTools.tools ?? [];

/** Pi's coding tools that `choice` names and the registry does not have yet. */
function codingTools(
	choice: NonNullable<PiOptions["codingTools"]>,
	registered: ReadonlySet<string>,
): Extension | undefined {
	if (choice === false) return undefined;
	const names: readonly string[] =
		choice === true ? CODING_TOOLS.map((tool) => tool.name) : choice;
	const unknown = names.filter(
		(name) => !CODING_TOOLS.some((tool) => tool.name === name),
	);
	if (unknown.length > 0) {
		throw new Error(
			`pi() codingTools has no tool ${unknown.join(", ")}; it has ${CODING_TOOLS.map((tool) => tool.name).join(", ")}`,
		);
	}
	const tools = CODING_TOOLS.filter(
		(tool) => names.includes(tool.name) && !registered.has(tool.name),
	);
	return tools.length > 0 ? { ...CodingTools, tools } : undefined;
}

function snapshotWith(
	base: RegistrySnapshot,
	extension: Extension,
): RegistrySnapshot {
	const installed = [...base.installed(), extension];
	const tools = [
		...base.tools(),
		...(extension.tools ?? []).map((tool) => ({ extension, tool })),
	];
	const sections = [
		...base.sections(),
		...(extension.sections ?? []).map((section) => ({ extension, section })),
	];
	const tasks = [...base.tasks(), ...(extension.tasks ?? [])];
	return {
		installed: () => installed,
		extension: (name) =>
			name === extension.name ? extension : base.extension(name),
		tools: () => tools,
		sections: () => sections,
		tasks: () => tasks,
		task: (name) =>
			base.task(name) ??
			extension.tasks?.find((task) => task.definition.name === name),
	};
}
