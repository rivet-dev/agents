import {
	type RemoteProcess,
	runRemoteProcess,
	type Sandbox,
	type SandboxProvider,
} from "@rivet-dev/sandbox-adapter";

// The client of your sandbox service.
export interface VmClient {
	create(): Promise<string>;
	// Starts a stopped VM. Returns false when the VM no longer exists.
	start(id: string): Promise<boolean>;
	stop(id: string): Promise<void>;
	delete(id: string): Promise<void>;
	spawn(id: string, command: string, options: { cwd: string; env?: Record<string, string> }): Promise<RemoteProcess>;
	readFile(id: string, path: string): Promise<Uint8Array>;
	writeFile(id: string, path: string, content: string): Promise<void>;
	mkdir(id: string, path: string): Promise<void>;
	isDirectory(id: string, path: string): Promise<boolean>;
	list(id: string, path: string): Promise<string[]>;
	exists(id: string, path: string): Promise<boolean>;
}

export function vmProvider(vms: VmClient): SandboxProvider {
	const cwd = "/workspace";
	return {
		name: "my-vms",
		cwd,
		create: () => vms.create(),
		connect: async (_c, id) => {
			if (!(await vms.start(id))) return undefined;
			await vms.mkdir(id, cwd);
			return vmSandbox(vms, id, cwd);
		},
		suspend: (_c, id) => vms.stop(id),
		destroy: (_c, id) => vms.delete(id),
	};
}

function vmSandbox(vms: VmClient, id: string, cwd: string): Sandbox {
	return {
		cwd,
		exec: async (command, options) =>
			// Streams output and applies the timeout and abort signal.
			runRemoteProcess(await vms.spawn(id, command, { cwd: options.cwd, env: options.env }), options),
		readFile: (path) => vms.readFile(id, path),
		writeFile: (path, content) => vms.writeFile(id, path, content),
		mkdir: (path) => vms.mkdir(id, path),
		stat: async (path) => ({ isDirectory: await vms.isDirectory(id, path) }),
		readdir: (path) => vms.list(id, path),
		exists: (path) => vms.exists(id, path),
	};
}
