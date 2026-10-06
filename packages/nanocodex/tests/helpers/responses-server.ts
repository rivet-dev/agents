import type { IncomingHttpHeaders } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";

/** One `response.create` that asked the model to generate. */
export interface ModelRequest {
	body: { input: unknown[]; [key: string]: unknown };
	headers: IncomingHttpHeaders;
	/** The text of the last user message, which names the scripted reply. */
	prompt: string | undefined;
	/** How many earlier requests had the same prompt, so 0 is a turn's first model call. */
	step: number;
}

type Reply = (request: ModelRequest) => unknown[] | Promise<unknown[]>;

/**
 * A local OpenAI Responses WebSocket server. Each prompt text maps to a reply
 * function that returns the response's output items; other prompts get "ok".
 */
export interface ResponsesServer {
	url: string;
	requests: ModelRequest[];
	reply(prompt: string, reply: Reply): void;
	close(): Promise<void>;
}

export async function startResponsesServer(): Promise<ResponsesServer> {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise<void>((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
	const requests: ModelRequest[] = [];
	const replies = new Map<string, Reply>();
	// A continuation sends only new items and names the response it continues.
	const promptsByResponse = new Map<string, string | undefined>();
	let responses = 0;
	server.on("connection", (socket: WebSocket, upgrade) => {
		socket.on("message", async (data) => {
			const body = JSON.parse(data.toString("utf8"));
			if (body.generate === false) {
				send(socket, {
					type: "response.completed",
					response: { id: `warmup-${++responses}`, usage: null },
				});
				return;
			}
			const prompt =
				lastUserText(body.input) ??
				promptsByResponse.get(body.previous_response_id);
			const request: ModelRequest = {
				body,
				headers: upgrade.headers,
				prompt,
				step: requests.filter((earlier) => earlier.prompt === prompt).length,
			};
			requests.push(request);
			const reply =
				(prompt !== undefined && replies.get(prompt)) ||
				(() => [message("ok")]);
			const output = await reply(request);
			const id = `response-${++responses}`;
			promptsByResponse.set(id, prompt);
			send(socket, {
				type: "response.completed",
				response: {
					id,
					status: "completed",
					output,
					usage: {
						input_tokens: 10,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens: 2,
						output_tokens_details: { reasoning_tokens: 0 },
						total_tokens: 12,
					},
				},
			});
		});
	});
	const address = server.address();
	if (typeof address !== "object" || address === null) {
		throw new Error("responses server has no address");
	}
	return {
		url: `ws://127.0.0.1:${address.port}`,
		requests,
		reply: (prompt, reply) => {
			replies.set(prompt, reply);
		},
		close: () => {
			for (const socket of server.clients) socket.terminate();
			return new Promise((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}

/** An assistant message output item. */
export function message(text: string) {
	return {
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text }],
	};
}

/** A Code Mode `exec` call that runs `code` with the agent's tools. */
export function exec(code: string, callId = "call-exec") {
	return {
		type: "custom_tool_call",
		id: `item-${callId}`,
		call_id: callId,
		status: "completed",
		name: "exec",
		input: code,
	};
}

function send(socket: WebSocket, value: unknown) {
	if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
}

function lastUserText(input: unknown): string | undefined {
	if (!Array.isArray(input)) return undefined;
	for (let index = input.length - 1; index >= 0; index--) {
		const item = input[index] as {
			type?: string;
			role?: string;
			content?: { type?: string; text?: string }[];
		};
		if (item.type === "message" && item.role === "user") {
			return item.content?.find((part) => part.type === "input_text")?.text;
		}
	}
	return undefined;
}
