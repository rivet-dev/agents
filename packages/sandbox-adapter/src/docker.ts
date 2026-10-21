import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type {
	Sandbox,
	SandboxActorContext,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxProvider,
} from "./index.js";

/** Label on every container this provider creates. Its value is the sandbox id. */
export const DOCKER_SANDBOX_LABEL = "dev.rivet.sandbox-adapter.sandbox-id";

export interface DockerProviderOptions {
	/** Image to run. It must include `/bin/sh`. Defaults to `ubuntu:24.04`. */
	image?: string;
	/** Working directory inside the container, created when the Actor connects. Defaults to `/workspace`. */
	cwd?: string;
	/** Environment variables of the container. The host environment is never passed in. */
	env?: Record<string, string>;
	/** Docker network to join. Use `"none"` for no network access. Defaults to Docker's `bridge` network. */
	network?: string;
	/** Container ports to publish on a random `127.0.0.1` host port. Read the address with `dockerPortAddress`. */
	ports?: number[];
	/**
	 * Runs the image's own entrypoint and command, for images such as
	 * `cloudflare/sandbox` that start a long-running server. By default the
	 * container runs an idle process instead.
	 */
	keepImageEntrypoint?: boolean;
	/** Path of the Docker CLI. Defaults to `docker` on `PATH`. */
	docker?: string;
}

/**
 * Runs an agent's file and shell tools in a local Docker container. Meant for
 * local development. The container has no host mounts, no host environment,
 * and no privileges. It is stopped while the actor sleeps and removed when
 * the actor is destroyed.
 */
export function dockerProvider(
	options: DockerProviderOptions = {},
): SandboxProvider {
	const cwd = posix.normalize(options.cwd ?? "/workspace");
	if (!posix.isAbsolute(cwd))
		throw new Error(`docker cwd must be an absolute path, received ${cwd}`);
	const network = options.network ?? "bridge";
	if (network === "host" || network.startsWith("container:"))
		throw new Error(
			`docker network ${network} shares the host's or another container's network and is not allowed`,
		);
	const docker = new DockerCli(options.docker ?? "docker");
	return {
		name: "docker",
		cwd,
		create: async (c) => {
			const id = randomUUID();
			await docker.run(createArgs(id, c, cwd, network, options));
			return id;
		},
		connect: async (_c, id) => {
			const container = await findContainer(docker, id);
			if (!container) return undefined;
			if (!container.running) await docker.run(["start", container.id]);
			const sandbox = dockerSandbox(docker, container.id, cwd);
			await sandbox.mkdir(cwd);
			return sandbox;
		},
		suspend: async (_c, id) => {
			const container = await findContainer(docker, id);
			if (container?.running)
				await docker.run(["stop", "--time", "1", container.id]);
		},
		destroy: async (_c, id) => {
			const container = await findContainer(docker, id);
			if (container)
				await docker.run(["rm", "--force", "--volumes", container.id]);
		},
	};
}

/**
 * Returns the `127.0.0.1:<port>` host address a published container port is
 * reachable at, or undefined when the sandbox or port is not published.
 */
export async function dockerPortAddress(
	id: string,
	port: number,
	options: Pick<DockerProviderOptions, "docker"> = {},
): Promise<string | undefined> {
	const docker = new DockerCli(options.docker ?? "docker");
	const container = await findContainer(docker, id);
	if (!container?.running) return undefined;
	const result = await docker.exec(["port", container.id, `${port}/tcp`]);
	if (result.exitCode !== 0) return undefined;
	return result.stdout.toString().split("\n")[0]?.trim() || undefined;
}

function createArgs(
	id: string,
	c: SandboxActorContext,
	cwd: string,
	network: string,
	options: DockerProviderOptions,
): string[] {
	const args = [
		"run",
		"--detach",
		"--init",
		"--name",
		`rivet-sandbox-${id}`,
		"--label",
		`${DOCKER_SANDBOX_LABEL}=${id}`,
		"--label",
		`dev.rivet.sandbox-adapter.actor-id=${c.actorId}`,
		"--network",
		network,
		"--security-opt",
		"no-new-privileges",
		"--workdir",
		cwd,
	];
	for (const [key, value] of Object.entries(options.env ?? {})) {
		// `--env KEY` without a value copies the host's variable, so require one.
		if (!key || key.includes("="))
			throw new Error(`invalid docker env variable name ${key}`);
		args.push("--env", `${key}=${value}`);
	}
	for (const port of options.ports ?? []) {
		// An empty host port picks a free one. Binding to 127.0.0.1 keeps it off other interfaces.
		args.push("--publish", `127.0.0.1::${port}`);
	}
	const image = options.image ?? "ubuntu:24.04";
	if (options.keepImageEntrypoint) args.push(image);
	else args.push("--entrypoint", "tail", image, "-f", "/dev/null");
	return args;
}

async function findContainer(
	docker: DockerCli,
	id: string,
): Promise<{ id: string; running: boolean } | undefined> {
	const result = await docker.run([
		"ps",
		"--all",
		"--no-trunc",
		"--filter",
		`label=${DOCKER_SANDBOX_LABEL}=${id}`,
		"--format",
		"{{.ID}} {{.State}}",
	]);
	const [line] = result.stdout.toString().trim().split("\n");
	if (!line) return undefined;
	const [containerId, state] = line.split(" ");
	if (!containerId) return undefined;
	return { id: containerId, running: state === "running" };
}

// Records the shell's pid so a kill can find the command's process tree,
// since ending the `docker exec` client leaves the command running. A kill
// that arrives before the pid is written leaves a marker the wrapper checks.
const EXEC_WRAPPER =
	'd=/tmp/.rivet-exec; mkdir -p $d && echo $$ > "$d/$1"; if [ -f "$d/$1.kill" ]; then rm -f "$d/$1" "$d/$1.kill"; exit 137; fi; /bin/sh -c "$2"; s=$?; rm -f "$d/$1"; exit $s';

// Stops each process before reading its children so none can fork past the kill.
const KILL_TREE =
	't() { kill -STOP "$1" 2>/dev/null; for c in $(cat /proc/"$1"/task/*/children 2>/dev/null); do t "$c"; done; kill -KILL "$1" 2>/dev/null; }; d=/tmp/.rivet-exec; mkdir -p $d && touch "$d/$1.kill"; if [ -f "$d/$1" ]; then t "$(cat "$d/$1")"; rm -f "$d/$1" "$d/$1.kill"; fi';

function dockerSandbox(
	docker: DockerCli,
	container: string,
	cwd: string,
): Sandbox {
	const sh = (script: string, args: string[], input?: string) =>
		docker.exec(
			["exec", ...(input === undefined ? [] : ["--interactive"]), container],
			{ script, args, input },
		);
	const check = async (
		operation: string,
		path: string,
		script: string,
		input?: string,
	) => {
		const result = await sh(script, [path], input);
		if (result.exitCode !== 0)
			throw new Error(
				`docker ${operation} ${path} failed: ${result.stderr.toString().trim() || `exit code ${result.exitCode}`}`,
			);
		return result.stdout;
	};
	return {
		cwd,
		exec: (command, options) => exec(docker, container, command, options),
		readFile: async (path) =>
			new Uint8Array(await check("readFile", path, 'cat -- "$1"')),
		writeFile: async (path, content) => {
			await check("writeFile", path, 'cat > "$1"', content);
		},
		mkdir: async (path) => {
			await check("mkdir", path, 'mkdir -p -- "$1"');
		},
		stat: async (path) => ({
			isDirectory:
				(
					await check(
						"stat",
						path,
						'if [ -d "$1" ]; then echo d; elif [ -e "$1" ]; then echo f; else echo "no such file or directory" >&2; exit 1; fi',
					)
				)
					.toString()
					.trim() === "d",
		}),
		readdir: async (path) =>
			(
				await check(
					"readdir",
					path,
					'cd -- "$1" || exit 1; for f in * .[!.]* ..?*; do if [ -e "$f" ] || [ -L "$f" ]; then printf "%s\\0" "$f"; fi; done',
				)
			)
				.toString()
				.split("\0")
				.filter(Boolean),
		exists: async (path) => (await sh('[ -e "$1" ]', [path])).exitCode === 0,
	};
}

async function exec(
	docker: DockerCli,
	container: string,
	command: string,
	options: SandboxExecOptions,
): Promise<SandboxExecResult> {
	if (options.signal?.aborted) throw new Error("aborted");
	const token = randomUUID();
	const args = ["exec", "--workdir", options.cwd];
	for (const [key, value] of Object.entries(options.env ?? {})) {
		if (!key || key.includes("="))
			throw new Error(`invalid docker env variable name ${key}`);
		args.push("--env", `${key}=${value}`);
	}
	args.push(container);
	let ended: "aborted" | "timeout" | undefined;
	const kill = (reason: "aborted" | "timeout") => {
		if (ended) return;
		ended = reason;
		docker
			.exec(["exec", container], { script: KILL_TREE, args: [token] })
			.catch(() => {});
	};
	const abort = () => kill("aborted");
	options.signal?.addEventListener("abort", abort, { once: true });
	const timer = options.timeoutMs
		? setTimeout(() => kill("timeout"), options.timeoutMs)
		: undefined;
	try {
		const result = await docker.exec(args, {
			script: EXEC_WRAPPER,
			args: [token, command],
			onData: options.onData,
		});
		if (ended === "aborted") throw new Error("aborted");
		return {
			exitCode: ended === "timeout" ? null : result.exitCode,
			timedOut: ended === "timeout",
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
}

interface CliResult {
	exitCode: number | null;
	stdout: Buffer;
	stderr: Buffer;
}

class DockerCli {
	constructor(private readonly binary: string) {}

	/** Runs a Docker command and throws when it fails. */
	async run(args: string[]): Promise<CliResult> {
		const result = await this.exec(args);
		if (result.exitCode !== 0)
			throw new Error(
				`docker ${args[0]} failed: ${result.stderr.toString().trim() || `exit code ${result.exitCode}`}`,
			);
		return result;
	}

	/**
	 * Runs a Docker command and returns its result. When `script` is set, it
	 * runs as `/bin/sh -c script sh ...args` after `args`.
	 */
	exec(
		args: string[],
		shell?: {
			script: string;
			args: string[];
			input?: string;
			onData?: (chunk: Uint8Array) => void;
		},
	): Promise<CliResult> {
		const argv = shell
			? [...args, "/bin/sh", "-c", shell.script, "sh", ...shell.args]
			: args;
		return new Promise((resolve, reject) => {
			const child = spawn(this.binary, argv, {
				stdio: [shell?.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			});
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			child.stdout?.on("data", (data: Buffer) => {
				stdout.push(data);
				shell?.onData?.(data);
			});
			child.stderr?.on("data", (data: Buffer) => {
				stderr.push(data);
				shell?.onData?.(data);
			});
			child.on("error", (error) =>
				reject(new Error(`could not run ${this.binary}`, { cause: error })),
			);
			child.on("close", (exitCode) =>
				resolve({
					exitCode,
					stdout: Buffer.concat(stdout),
					stderr: Buffer.concat(stderr),
				}),
			);
			if (shell?.input !== undefined) child.stdin?.end(shell.input);
		});
	}
}
