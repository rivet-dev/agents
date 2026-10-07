import { ConversationBusy } from "@earendil-works/pi-durable";
import { UserError } from "rivetkit";

/**
 * The error a client receives for a failed Pi Durable call. `ConversationBusy`
 * is the one Pi error a caller is meant to handle, so it becomes a
 * `UserError` with Pi's error name as the code. Every other error is returned
 * as is, and RivetKit reports it to clients as an internal error.
 */
export function toClientError(error: unknown): unknown {
	if (error instanceof ConversationBusy) {
		return new UserError(error.message, {
			code: error.name,
			metadata: { conversationId: error.conversationId },
			cause: error,
		});
	}
	return error;
}
