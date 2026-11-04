import type { SpanAttributes } from "@earendil-works/pi-telemetry";
import {
	createTelemetryAdapterConformance,
	type TelemetryAdapterFixture,
} from "@earendil-works/pi-telemetry/testing";
import { SpanStatusCode } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { describe, test } from "vitest";
import { createPiTelemetry } from "../src/tracing.js";

/** The attributes the adapter adds on top of what Pi asked for. */
const ADAPTER_ATTRIBUTES = new Set(["rivet.actor.id", "error.type"]);

function carrierOf(traceId: string, spanId: string, flags: number) {
	return {
		traceparent: `00-${traceId}-${spanId}-${flags.toString(16).padStart(2, "0")}`,
	};
}

function piAttributes(span: ReadableSpan): SpanAttributes {
	return Object.fromEntries(
		Object.entries(span.attributes).filter(
			([name]) => !ADAPTER_ATTRIBUTES.has(name),
		),
	) as SpanAttributes;
}

/** A fresh adapter over a real OpenTelemetry SDK, with its spans in the shape the suite reads. */
async function createFixture(): Promise<TelemetryAdapterFixture> {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	const context = createPiTelemetry("actor", {
		tracer: provider.getTracer("conformance"),
		// The suite compares status messages. Every other adapter drops them, which the
		// canary test in tracing.test.ts proves through a real actor and collector.
		statusMessage: (status) =>
			status.status === "error" ? status.error?.message : undefined,
	});
	return {
		context,
		propagation: context.propagation,
		getSpans: async () => {
			const spans = exporter.getFinishedSpans();
			const local = new Map(
				spans.map((span, index) => [span.spanContext().spanId, index]),
			);
			return spans.map((span, endSequence) => {
				const { traceId, spanId, traceFlags } = span.spanContext();
				const parent = span.parentSpanContext;
				return {
					id: endSequence,
					parentId: parent ? (local.get(parent.spanId) ?? null) : null,
					context: carrierOf(traceId, spanId, traceFlags),
					parentContext: parent
						? carrierOf(parent.traceId, parent.spanId, parent.traceFlags)
						: null,
					links: span.links.map((link) => ({
						context: carrierOf(
							link.context.traceId,
							link.context.spanId,
							link.context.traceFlags,
						),
						attributes: (link.attributes ?? {}) as SpanAttributes,
					})),
					name: span.name,
					attributes: piAttributes(span),
					events: span.events.map((event) => ({
						name: event.name,
						attributes: (event.attributes ?? {}) as SpanAttributes,
					})),
					status:
						span.status.code === SpanStatusCode.ERROR
							? {
									status: "error" as const,
									error: {
										name: String(span.attributes["error.type"]),
										message: span.status.message ?? "",
									},
								}
							: { status: "ok" as const },
					settled: true,
					endSequence,
				};
			});
		},
		[Symbol.asyncDispose]: () => provider.shutdown(),
	};
}

describe("pi telemetry adapter conformance", () => {
	for (const conformance of createTelemetryAdapterConformance(createFixture)) {
		test(`${conformance.group}: ${conformance.name}`, () => conformance.run());
	}
});
