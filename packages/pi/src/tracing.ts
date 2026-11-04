import type { Context } from "@earendil-works/chord";
import { withTelemetry } from "@earendil-works/chord/context";
import type {
	SpanAttributes,
	SpanLink,
	SpanOptions,
	SpanStatus,
	TelemetryCarrier,
	TelemetryContext,
	TelemetryPropagation,
	TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import {
	type Attributes,
	context,
	createTraceState,
	isSpanContextValid,
	type Context as OtelContext,
	ROOT_CONTEXT,
	type Span,
	type SpanContext,
	SpanKind,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";

const TRACER_NAME = "@rivet-dev/pi";
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** OpenTelemetry must never break a run, so a call into it that throws does nothing. */
function guarded<T>(call: () => T): T | undefined {
	try {
		return call();
	} catch {
		return undefined;
	}
}

/** Runs `body` with `active` as the active context, and without it if entering it throws. */
function runActive<T>(active: OtelContext, body: () => T): T {
	let entered = false;
	try {
		return context.with(active, () => {
			entered = true;
			return body();
		});
	} catch (error) {
		if (entered) throw error;
		return body();
	}
}

function attributesOf(attributes: SpanAttributes | undefined): Attributes {
	const defined: Attributes = {};
	for (const [name, value] of Object.entries(attributes ?? {})) {
		if (value === undefined) continue;
		defined[name] = (Array.isArray(value) ? [...value] : value) as
			| string
			| number
			| boolean
			| string[];
	}
	return defined;
}

interface OtelAdapter {
	tracer(): Tracer;
	attributes: Attributes;
	propagation: TelemetryPropagation;
	statusMessage?: (status: SpanStatus) => string | undefined;
}

/** A parent for new spans: the root, or a span extracted from a stored carrier. */
class OtelTelemetry implements TelemetryContext {
	readonly propagation: TelemetryPropagation;

	constructor(
		readonly adapter: OtelAdapter,
		readonly parent: OtelContext,
	) {
		this.propagation = adapter.propagation;
	}

	protected get settled(): boolean {
		return false;
	}

	async startSpan<T>(
		options: SpanOptions,
		callback: (span: TelemetrySpan) => T | Promise<T>,
	): Promise<T> {
		const { adapter, parent } = this;
		const native = this.settled
			? undefined
			: guarded(() =>
					adapter.tracer().startSpan(
						options.name,
						{
							attributes: {
								...adapter.attributes,
								...attributesOf(options.attributes),
							},
							links: options.links?.flatMap(linksOf),
						},
						// Never the active context, so a background phase does not nest under an unrelated action.
						parent,
					),
				);
		const span = new OtelSpan(adapter, native);
		try {
			const result = await runActive(
				native ? trace.setSpan(parent, native) : parent,
				() => callback(span),
			);
			span.finish();
			return result;
		} catch (error) {
			span.finish({
				status: "error",
				error: {
					name: error instanceof Error ? error.name : "Error",
					message: error instanceof Error ? error.message : "",
				},
			});
			throw error;
		}
	}
}

class OtelSpan extends OtelTelemetry implements TelemetrySpan {
	#settled = false;
	#status: SpanStatus | undefined;

	constructor(
		adapter: OtelAdapter,
		readonly native: Span | undefined,
	) {
		super(adapter, native ? trace.setSpan(ROOT_CONTEXT, native) : ROOT_CONTEXT);
	}

	protected override get settled(): boolean {
		return this.#settled;
	}

	#record(call: (native: Span) => void): void {
		const { native } = this;
		if (!this.#settled && native) guarded(() => call(native));
	}

	addLink(link: SpanLink): void {
		for (const otelLink of linksOf(link)) {
			this.#record((native) => native.addLink(otelLink));
		}
	}

	addEvent(name: string, attributes?: SpanAttributes): void {
		this.#record((native) => native.addEvent(name, attributesOf(attributes)));
	}

	setAttributes(attributes: SpanAttributes): void {
		this.#record((native) => native.setAttributes(attributesOf(attributes)));
	}

	setStatus(status: SpanStatus): void {
		if (!this.#settled) this.#status = status;
	}

	/**
	 * Ends the span with the last status set, or else with `thrown`. Success stays
	 * Unset. A failure records its name and drops its message, because Pi's
	 * diagnostics can contain caller content.
	 */
	finish(thrown?: SpanStatus): void {
		const status = this.#status ?? thrown;
		this.#record((native) => {
			if (status?.status !== "error") return;
			native.setAttribute("error.type", status.error?.name ?? "_OTHER");
			native.setStatus({
				code: SpanStatusCode.ERROR,
				message: this.adapter.statusMessage?.(status),
			});
		});
		this.#record((native) => native.end());
		this.#settled = true;
	}
}

function spanContextOf(telemetry: TelemetryContext): SpanContext | undefined {
	if (!(telemetry instanceof OtelTelemetry)) return undefined;
	return guarded(() => {
		const spanContext = trace.getSpanContext(telemetry.parent);
		return spanContext && isSpanContextValid(spanContext)
			? spanContext
			: undefined;
	});
}

function linksOf(link: SpanLink) {
	const spanContext = spanContextOf(link.context);
	return spanContext
		? [{ context: spanContext, attributes: attributesOf(link.attributes) }]
		: [];
}

/**
 * Writes the carrier from the span context and not through the global
 * propagator, which needs an SDK. With no SDK, spans have no valid context, so
 * Pi stores nothing.
 */
function injectCarrier(
	telemetry: TelemetryContext,
): TelemetryCarrier | undefined {
	const spanContext = spanContextOf(telemetry);
	if (!spanContext) return undefined;
	return guarded(() => {
		const flags = spanContext.traceFlags.toString(16).padStart(2, "0");
		const tracestate = spanContext.traceState?.serialize();
		return {
			traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`,
			...(tracestate ? { tracestate } : {}),
		};
	});
}

function extractParent(carrier: TelemetryCarrier | undefined): OtelContext {
	const match = carrier?.traceparent?.match(TRACEPARENT);
	if (!match) return ROOT_CONTEXT;
	const parent = guarded<SpanContext>(() => ({
		traceId: match[1] as string,
		spanId: match[2] as string,
		traceFlags: Number.parseInt(match[3] as string, 16),
		isRemote: true,
		traceState: carrier?.tracestate
			? createTraceState(carrier.tracestate)
			: undefined,
	}));
	return parent && isSpanContextValid(parent)
		? trace.setSpanContext(ROOT_CONTEXT, parent)
		: ROOT_CONTEXT;
}

/**
 * Pi Durable's telemetry over `@opentelemetry/api`. Without an SDK, every call
 * does nothing. `statusMessage` exists for Pi's conformance suite, which
 * compares messages. Nothing else sets it, so traces hold no diagnostics.
 */
export function createPiTelemetry(
	actorId: string,
	options: Pick<OtelAdapter, "statusMessage"> & { tracer?: Tracer } = {},
): OtelTelemetry {
	const adapter: OtelAdapter = {
		// Read per span, so an SDK started after the actor opened still gets its spans.
		tracer: () => options.tracer ?? trace.getTracer(TRACER_NAME),
		attributes: { "rivet.actor.id": actorId },
		statusMessage: options.statusMessage,
		propagation: {
			inject: injectCarrier,
			extract: (carrier) => new OtelTelemetry(adapter, extractParent(carrier)),
		},
	};
	return new OtelTelemetry(adapter, ROOT_CONTEXT);
}

/**
 * `parent` with the active span as its telemetry, so a run's root span links to
 * its caller. Each run is its own trace, like a scheduled action in RivetKit.
 */
export function withCallerSpan(actorId: string, parent: Context): Context {
	const caller = guarded(() => {
		const span = trace.getSpan(context.active());
		return span && isSpanContextValid(span.spanContext()) ? span : undefined;
	});
	return caller
		? withTelemetry(
				new OtelSpan(createPiTelemetry(actorId).adapter, caller),
				parent,
			)
		: parent;
}

/**
 * Runs one Pi run inside an `invoke_agent pi` span, a child of the active span,
 * which is the `prompt` action span when RivetKit tracing is on. The action
 * span cannot show the outcome, because a model error does not reject the run,
 * so this span records it with OpenTelemetry GenAI attributes. An unanswered
 * submission marks the span as failed. Prompt text, tool arguments, and tool
 * results are not recorded.
 */
export async function traceRun<T extends { status: string; reason?: string }>(
	actorId: string,
	conversationId: number,
	model: string | undefined,
	run: () => Promise<T>,
): Promise<T> {
	const span = guarded(() =>
		trace.getTracer(TRACER_NAME).startSpan("invoke_agent pi", {
			kind: SpanKind.INTERNAL,
			attributes: {
				"gen_ai.operation.name": "invoke_agent",
				"gen_ai.agent.name": "pi",
				"gen_ai.conversation.id": String(conversationId),
				"gen_ai.request.model": model,
				"rivet.actor.id": actorId,
			},
		}),
	);
	const fail = (errorType: string, message?: string) =>
		guarded(() => {
			span?.setAttribute("error.type", errorType);
			span?.setStatus({ code: SpanStatusCode.ERROR, message });
		});
	try {
		const result = await (span
			? runActive(trace.setSpan(context.active(), span), run)
			: run());
		if (result.status === "unanswered") fail("unanswered", result.reason);
		return result;
	} catch (error) {
		fail("run_error");
		throw error;
	} finally {
		guarded(() => span?.end());
	}
}
