import { ConversationBusy } from "@earendil-works/pi-durable";
import { UserError } from "rivetkit";

/** Pi Durable 1.4 has no typed error for this, so its message is the only signal. */
const NEWER_SCHEMA =
	/SQLite schema version (\d+) is newer than supported version (\d+)/;

/**
 * The error a client receives for a failed Pi Durable call. `ConversationBusy`
 * becomes a `UserError` with Pi's error name as the code, because a caller can
 * handle it. Storage from a newer Pi Durable schema, such as after a rollback,
 * becomes a `UserError` with the code `pi_schema_too_new`, because no retry
 * can fix it. Every other error is returned as is, and RivetKit reports it to
 * clients as an internal error.
 */
export function toClientError(error: unknown): unknown {
	if (error instanceof ConversationBusy) {
		return new UserError(error.message, {
			code: error.name,
			metadata: { conversationId: error.conversationId },
			cause: error,
		});
	}
	const newerSchema =
		error instanceof Error ? NEWER_SCHEMA.exec(error.message) : null;
	if (newerSchema) {
		const [, stored, supported] = newerSchema;
		return new UserError(
			`This actor's Pi Durable data has schema version ${stored}, and the deployed code supports up to version ${supported}. Deploy a @rivet-dev/pi version that supports it. Pi Durable data can't roll back.`,
			{ code: "pi_schema_too_new", cause: error },
		);
	}
	return error;
}
