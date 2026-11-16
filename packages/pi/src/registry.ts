import type {
	Extension,
	HarnessSettings,
	RegistryReader,
	RegistrySnapshot,
} from "@earendil-works/pi-durable";

/**
 * The app's registry and settings plus `extension`. Conversations that use the
 * default selection get it: without one every installed extension is
 * selected, and an app selection gets it appended.
 */
export function withExtension(
	options: { registry: RegistryReader; settings?: HarnessSettings },
	extension: Extension,
): { registry: RegistryReader; settings?: HarnessSettings } {
	let cached:
		| { base: RegistrySnapshot; snapshot: RegistrySnapshot }
		| undefined;
	const registry: RegistryReader = {
		snapshot() {
			const base = options.registry.snapshot();
			if (cached?.base !== base) {
				cached = { base, snapshot: snapshotWith(base, extension) };
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
				return target.extensions && [...target.extensions, extension];
			},
		});
	return { registry, settings };
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
