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
 * The Pi Durable extensions that `pi()` options turn on: `CodingTools` (by
 * default with a sandbox) and tool search. One the app's registry already has
 * is not installed again.
 */
export function builtInExtensions(
	options: PiOptions,
	registry: RegistryReader,
): Extension[] {
	const installed = registry.snapshot();
	return [
		codingTools(options.codingTools ?? options.sandbox !== undefined),
		options.toolSearch ? createToolSearchExtension() : undefined,
	].filter(
		(extension): extension is Extension =>
			extension !== undefined && !installed.extension(extension.name),
	);
}

function codingTools(
	choice: NonNullable<PiOptions["codingTools"]>,
): Extension | undefined {
	if (choice === false) return undefined;
	if (choice === true) return CodingTools;
	const tools = CodingTools.tools ?? [];
	const unknown = choice.filter(
		(name) => !tools.some((tool) => tool.name === name),
	);
	if (unknown.length > 0) {
		throw new Error(
			`pi() codingTools has no tool ${unknown.join(", ")}; it has ${tools.map((tool) => tool.name).join(", ")}`,
		);
	}
	return {
		...CodingTools,
		tools: tools.filter((tool) => choice.includes(tool.name as never)),
	};
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
