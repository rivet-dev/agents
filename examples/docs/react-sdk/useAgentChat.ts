import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { contentText } from "@earendil-works/pi-ai";
import type { ConversationId, ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { PiViewFrame } from "@rivet-dev/pi";
import { createRivetKit } from "@rivetkit/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { registry } from "../pi/server";

const { useActor } = createRivetKit<typeof registry>();

export type ChatMessage = { id: string; role: "user" | "assistant"; text: string };

export function useAgentChat(key: string[]) {
	const agent = useActor({ name: "agent", key });
	const conn = agent.connection;
	const [rootId, setRootId] = useState<ConversationId | null>(null);
	const [view, setView] = useState<ConversationView | null>(null);
	const lastSeq = useRef(0);
	// Operations that arrive before the watch call returns.
	const early = useRef<Op[]>([]);

	// Reads the conversation, then sends its changes to this connection as pi.view frames.
	const watch = useCallback(async () => {
		if (!conn) return;
		const root = await conn.harness.root();
		lastSeq.current = 0;
		early.current = [];
		const { value } = await conn.conversation.watch(root.id);
		setView(applyImmutable(value, early.current));
		setRootId(root.id);
	}, [conn]);

	useEffect(() => {
		void watch();
	}, [watch]);

	agent.useEvent("pi.view", (frame) => {
		// RivetKit types event payloads as unknown, so name the frame's type.
		const { seq, value, ops = [] } = frame as PiViewFrame;
		// A missing frame means missed changes, so start again from a new view.
		if (seq !== 0 && seq !== lastSeq.current + 1) return void watch();
		lastSeq.current = seq;
		if (rootId === null) early.current.push(...ops);
		setView((current) => value ?? (current && applyImmutable(current, ops)));
	});

	const live = view?.docs["pi.live"] as LiveState | undefined;
	const partial = live?.generation?.message;

	return {
		messages: view?.entries.flatMap(toChatMessages) ?? [],
		streaming: partial ? contentText(partial.content, "") : "",
		tool: live?.tools?.find((slot) => slot.status === "running")?.name ?? null,
		running: live?.run !== undefined,
		ready: conn !== null && rootId !== null,
		// Starts a run without waiting for it. The view shows the answer.
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
		const text = contentText(message.content, "");
		return text ? [{ id: `${entry.id}:${index}`, role: message.role, text }] : [];
	});
}
