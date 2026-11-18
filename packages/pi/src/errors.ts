import { ConversationBusy } from "@earendil-works/pi-durable";
import { UserError } from "rivetkit";

/** Pi Durable has no typed errors for these, so their messages are the only signal. */
const NEWER_SCHEMA =
	/SQLite schema version (?<stored>\d+) is newer than supported version (?<supported>\d+)/;
const NEWER_DOCUMENT =
	/Document \d+ \((?<kind>[^)]+)\) has newer version (?<stored>\d+) than (?<supported>\d+)/;

/**
 * The error a client receives for a failed Pi Durable call. `ConversationBusy`
 * becomes a `UserError` with Pi's error name as the code, because a caller can
 * handle it. Storage or a document from a newer Pi Durable, such as after a
 * rollback, becomes a `UserError` with the code `pi_schema_too_new`, because no
 * retry can fix it. Every other error is returned as is, and RivetKit reports it to
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
	const message = error instanceof Error ? error.message : "";
	const schema = NEWER_SCHEMA.exec(message)?.groups;
	if (schema) {
		return schemaTooNew(
			`Pi Durable data has schema version ${schema.stored}`,
			schema.supported,
			error,
		);
	}
	const document = NEWER_DOCUMENT.exec(message)?.groups;
	if (document) {
		return schemaTooNew(
			`${document.kind} document has version ${document.stored}`,
			document.supported,
			error,
		);
	}
	return error;
}

function schemaTooNew(
	stored: string,
	supported: string | undefined,
	cause: unknown,
): UserError {
	return new UserError(
		`This actor's ${stored}, and the deployed code supports up to version ${supported}. Deploy a @rivet-dev/pi version that supports it. Pi Durable data can't roll back.`,
		{ code: "pi_schema_too_new", cause },
	);
}
