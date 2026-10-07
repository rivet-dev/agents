import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

export const getOrder = defineTool({
	name: "get_order",
	description: "Look up an order's status by its id.",
	parameters: Type.Object({ orderId: Type.String() }),
	// A lookup changes nothing, so running it twice is harmless.
	replay: "safe",
	execute: async ({ orderId }, _api, context) => {
		const order = await fetchOrder(orderId, context.abortSignal);
		const text = `Status: ${order.status}. Total: $${order.total}.`;
		return { content: [{ type: "text", text }], details: order };
	},
});

async function fetchOrder(orderId: string, signal: AbortSignal | undefined) {
	const response = await fetch(`https://api.example.com/orders/${encodeURIComponent(orderId)}`, {
		headers: { authorization: `Bearer ${process.env.ORDERS_API_TOKEN}` },
		signal,
	});
	if (response.status === 404) throw new Error(`No order with id ${orderId}.`);
	if (!response.ok) throw new Error(`The orders API returned ${response.status}.`);
	return (await response.json()) as { status: string; total: number };
}
