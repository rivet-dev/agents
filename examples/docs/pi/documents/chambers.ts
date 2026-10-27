import { defineDoc } from "@earendil-works/pi-durable";

// The Portal 2 test chambers a player has solved, kept with the conversation.
export const Chambers = defineDoc<{ solved: string[] }>({
	kind: "aperture.chambers",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ solved: [] }),
	// Store the whole document every 50 changes, so loading it replays at most 50.
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 50,
});
