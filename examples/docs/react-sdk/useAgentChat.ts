import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { createRivetKit } from "@rivetkit/react";
import { useEffect, useState } from "react";
import type { registry } from "../pi/server";

const { useActor } = createRivetKit<typeof registry>();

export type ChatMessage = { id: string; role: "user" | "assistant"; text: string };

export function useAgentChat(key: string[]) {
	const agent = useActor({ name: "agent", key });
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [streaming, setStreaming] = useState("");
	const [tool, setTool] = useState<string | null>(null);
	const [running, setRunning] = useState(false);

	useEffect(() => {
		agent.connection?.getMessages().then((history) => setMessages(history.flatMap(toChatMessage)));
	}, [agent.connection]);

	agent.useEvent("event", (event) => {
		if (event.type === "agent_start") setRunning(true);
		if (event.type === "agent_settled") setRunning(false);
		if (event.type === "tool_execution_start") setTool(event.toolName);
		if (event.type === "tool_execution_end") setTool(null);
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			const { delta } = event.assistantMessageEvent;
			setStreaming((text) => text + delta);
		}
		if (event.type === "message_end") {
			setStreaming("");
			setMessages((current) => [...current, ...toChatMessage(event.message)]);
		}
	});

	return {
		messages,
		streaming,
		tool,
		running,
		ready: agent.connection !== null,
		send: (text: string) => agent.connection?.prompt(text),
		stop: () => agent.connection?.abort(),
	};
}

function toChatMessage(message: { role: string }): ChatMessage[] {
	if (message.role !== "user" && message.role !== "assistant") return [];
	const { role, content } = message as UserMessage | AssistantMessage;
	const text =
		typeof content === "string"
			? content
			: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
	return text ? [{ id: crypto.randomUUID(), role, text }] : [];
}
