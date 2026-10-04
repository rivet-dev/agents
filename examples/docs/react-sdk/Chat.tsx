import { type FormEvent, useState } from "react";
import { useAgentChat } from "./useAgentChat";

export function Chat({ userId }: { userId: string }) {
	const chat = useAgentChat(["support", userId]);
	const [text, setText] = useState("");

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!text.trim()) return;
		void chat.send(text);
		setText("");
	}

	return (
		<section>
			<ul>
				{chat.messages.map((message) => (
					<li key={message.id}>
						<strong>{message.role === "user" ? "You" : "Agent"}:</strong> {message.text}
					</li>
				))}
				{chat.streaming && (
					<li>
						<strong>Agent:</strong> {chat.streaming}
					</li>
				)}
			</ul>
			{chat.tool && <p>Running {chat.tool}…</p>}
			<form onSubmit={submit}>
				<input value={text} onChange={(event) => setText(event.target.value)} disabled={chat.running} />
				{chat.running ? (
					<button type="button" onClick={() => void chat.stop()}>
						Stop
					</button>
				) : (
					<button type="submit" disabled={!chat.ready}>
						Send
					</button>
				)}
			</form>
		</section>
	);
}
