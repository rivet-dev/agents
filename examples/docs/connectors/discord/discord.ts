import { InteractionResponseType, InteractionType, verifyKey } from "discord-interactions";
import { Hono } from "hono";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

export type DiscordCommand = { applicationId: string; token: string; prompt: string };

const client = createClient<typeof registry>();

export const discord = new Hono();

discord.post("/interactions", async (c) => {
	const body = await c.req.text();
	const signature = c.req.header("x-signature-ed25519") ?? "";
	const timestamp = c.req.header("x-signature-timestamp") ?? "";
	if (!(await verifyKey(body, signature, timestamp, process.env.DISCORD_PUBLIC_KEY ?? ""))) {
		return c.text("invalid signature", 401);
	}

	const interaction = JSON.parse(body);
	if (interaction.type === InteractionType.PING) return c.json({ type: InteractionResponseType.PONG });

	if (interaction.type === InteractionType.APPLICATION_COMMAND && interaction.data.name === "ask") {
		const prompt = interaction.data.options?.find((option: { name: string }) => option.name === "prompt")?.value;
		const agent = client.agent.getOrCreate(["discord", interaction.channel_id ?? interaction.channel?.id]);
		await agent.receive({ applicationId: interaction.application_id, token: interaction.token, prompt: String(prompt ?? "") });
		return c.json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
	}

	return c.text("unhandled interaction", 400);
});

export async function postReply(command: DiscordCommand, reply: string | undefined) {
	const url = `https://discord.com/api/v10/webhooks/${command.applicationId}/${command.token}/messages/@original`;
	await fetch(url, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content: (reply || "I finished without a reply.").slice(0, 2000) }),
	});
}
