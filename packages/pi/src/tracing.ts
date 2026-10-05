import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

/**
 * Runs one Pi run inside an `invoke_agent pi` span, a child of the active span,
 * which is the `prompt` action span when RivetKit tracing is on. The action
 * span cannot show the outcome, because a model error does not reject the run,
 * so this span records it with OpenTelemetry GenAI attributes. Prompt text,
 * tool arguments, and tool results are not recorded.
 */
export async function traceRun(
	session: AgentSession,
	actorId: string,
	run: () => Promise<void>,
): Promise<void> {
	if (session.isStreaming) return run();
	const span = trace.getTracer("@rivet-dev/pi").startSpan("invoke_agent pi", {
		kind: SpanKind.INTERNAL,
		attributes: {
			"gen_ai.operation.name": "invoke_agent",
			"gen_ai.agent.name": "pi",
			"gen_ai.conversation.id": session.sessionId,
			"gen_ai.request.model": session.model?.id,
			"rivet.actor.id": actorId,
		},
	});
	try {
		await context.with(trace.setSpan(context.active(), span), run);
		const last = session.messages.findLast(
			(message) => message.role === "assistant",
		);
		if (last?.role === "assistant" && last.stopReason === "error") {
			span.setAttribute("error.type", "model_error");
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: last.errorMessage,
			});
		}
	} catch (error) {
		span.setAttribute("error.type", "run_error");
		span.setStatus({ code: SpanStatusCode.ERROR });
		throw error;
	} finally {
		span.end();
	}
}

/**
 * Runs one `piDurable()` run inside an `invoke_agent pi` span, with the same
 * attributes as `traceRun`. An unanswered submission marks the span as failed.
 */
export async function traceDurableRun<
	T extends { status: string; reason?: string },
>(
	actorId: string,
	conversationId: number,
	model: string | undefined,
	run: () => Promise<T>,
): Promise<T> {
	const span = trace.getTracer("@rivet-dev/pi").startSpan("invoke_agent pi", {
		kind: SpanKind.INTERNAL,
		attributes: {
			"gen_ai.operation.name": "invoke_agent",
			"gen_ai.agent.name": "pi",
			"gen_ai.conversation.id": String(conversationId),
			"gen_ai.request.model": model,
			"rivet.actor.id": actorId,
		},
	});
	try {
		const result = await context.with(
			trace.setSpan(context.active(), span),
			run,
		);
		if (result.status === "unanswered") {
			span.setAttribute("error.type", "unanswered");
			span.setStatus({ code: SpanStatusCode.ERROR, message: result.reason });
		}
		return result;
	} catch (error) {
		span.setAttribute("error.type", "run_error");
		span.setStatus({ code: SpanStatusCode.ERROR });
		throw error;
	} finally {
		span.end();
	}
}
