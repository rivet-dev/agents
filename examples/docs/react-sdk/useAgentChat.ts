import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, ConversationId, EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable";
import { createRivetKit } from "@rivetkit/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { registry } from "../pi/server";

const { useActor } = createRivetKit<typeof registry>();

export type ChatMessage = { id: string; role: "user" | "assistant"; text: string };

export function useAgentChat(key: string[]) {
	const agent = useActor({ name: "agent", key });
	const conn = agent.connection;
	const [rootId, setRootId] = useState<ConversationId | null>(null);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [streaming, setStreaming] = useState("");
	const [tool, setTool] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const lastSeq = useRef(0);

	// A snapshot replaces everything the hook has.
	const applySnapshot = useCallback((snapshot: SnapshotEvent) => {
		setMessages(snapshot.entries.flatMap(toChatMessages));
		setStreaming(snapshot.generation?.message ? textOf(snapshot.generation.message) : "");
		setTool(snapshot.tools.find((slot) => slot.status === "running")?.name ?? null);
		setRunning(snapshot.run !== undefined);
	}, []);

	// Reads the conversation, then sends its events to this connection as pi.events.
	const watch = useCallback(async () => {
		if (!conn) return;
		const root = await conn.harness.root();
		lastSeq.current = 0;
		const { snapshot } = await conn.conversation.watchEvents(root.id);
		applySnapshot(snapshot);
		setRootId(root.id);
	}, [conn, applySnapshot]);

	useEffect(() => {
		void watch();
	}, [watch]);

	agent.useEvent("pi.events", ({ seq, events }) => {
		// A missing batch means missed events, so start again from a new snapshot.
		if (seq !== 0 && seq !== lastSeq.current + 1) return void watch();
		lastSeq.current = seq;
		for (const event of events) applyEvent(event);
	});

	function applyEvent(event: AgentEvent) {
		switch (event.type) {
			case "snapshot":
				return applySnapshot(event);
			case "run_start":
				return setRunning(true);
			case "run_end":
				return setRunning(false);
			case "tool_execution_start":
				return setTool(event.toolName);
			case "tool_execution_end":
				return setTool(null);
			case "message_start":
				if (event.message.role === "assistant") setStreaming(textOf(event.message));
				return;
			case "message_update":
				for (const change of event.changes) {
					if (change.type === "text_delta") setStreaming((text) => text + change.delta);
				}
				return;
			case "message_end":
				setStreaming("");
				setMessages((current) => [...current, ...toChatMessages(event.entry)]);
				return;
		}
	}

	return {
		messages,
		streaming,
		tool,
		running,
		ready: conn !== null && rootId !== null,
		// Starts a run without waiting for it. The events show the answer.
		send: (text: string) => {
			if (conn && rootId !== null) return conn.conversation.submit(rootId, { type: "input", content: text });
		},
		stop: () => {
			if (conn && rootId !== null) return conn.conversation.abort(rootId);
		},
	};
}

function toChatMessages(entry: EntryRecord): ChatMessage[] {
	return (entry.model ?? []).flatMap((message, index): ChatMessage[] => {
		if (message.role !== "user" && message.role !== "assistant") return [];
		const text = textOf(message);
		return text ? [{ id: `${entry.id}:${index}`, role: message.role, text }] : [];
	});
}

function textOf(message: UserMessage | AssistantMessage): string {
	if (typeof message.content === "string") return message.content;
	let text = "";
	for (const block of message.content) if (block.type === "text") text += block.text;
	return text;
}
