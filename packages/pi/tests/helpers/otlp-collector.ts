import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type CollectedAttributes = Record<
	string,
	string | number | boolean | undefined
>;

export interface CollectedSpan {
	name: string;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	attributes: CollectedAttributes;
	links: { traceId: string; spanId: string }[];
	/** OTLP's status code: 2 is an error. */
	statusCode: number;
}

export interface OtlpCollector {
	readonly endpoint: string;
	spans(): CollectedSpan[];
	/** Every export as sent, to search for what must not leave the process. */
	payloads(): string;
	/** Waits until no export has arrived for a while, so a span count is final. */
	quiet(): Promise<void>;
	close(): Promise<void>;
}

interface OtlpPayload {
	resourceSpans?: Array<{
		scopeSpans?: Array<{
			spans?: Array<{
				name: string;
				traceId: string;
				spanId: string;
				parentSpanId?: string;
				attributes?: Array<{
					key: string;
					value: {
						stringValue?: string;
						intValue?: string | number;
						doubleValue?: number;
						boolValue?: boolean;
					};
				}>;
				links?: Array<{ traceId: string; spanId: string }>;
				status?: { code?: number };
			}>;
		}>;
	}>;
}

const QUIET_MS = 500;

/** Points RivetKit and an OpenTelemetry SDK at a collector. Call before starting the SDK or a registry. */
export function exportTracesTo({ endpoint }: { endpoint: string }): void {
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = endpoint;
	process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/json";
	process.env.OTEL_TRACES_SAMPLER = "always_on";
	process.env.OTEL_BSP_SCHEDULE_DELAY = "10";
}

/** Receives OTLP/JSON trace exports: RivetKit's native spans, and the spans of an OpenTelemetry SDK. */
export async function startOtlpCollector(): Promise<OtlpCollector> {
	const bodies: Buffer[] = [];
	let lastExportAt = Date.now();
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			bodies.push(Buffer.concat(chunks));
			lastExportAt = Date.now();
			response.writeHead(200, { "content-type": "application/json" });
			response.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	return {
		endpoint: `http://127.0.0.1:${port}/v1/traces`,
		spans: () =>
			bodies.flatMap((body) =>
				(
					(JSON.parse(body.toString("utf8")) as OtlpPayload).resourceSpans ?? []
				).flatMap((resource) =>
					(resource.scopeSpans ?? []).flatMap((scope) =>
						(scope.spans ?? []).map((span) => ({
							name: span.name,
							traceId: span.traceId,
							spanId: span.spanId,
							parentSpanId: span.parentSpanId || undefined,
							attributes: Object.fromEntries(
								(span.attributes ?? []).map(({ key, value }) => [
									key,
									value.stringValue ??
										(value.intValue === undefined
											? (value.doubleValue ?? value.boolValue)
											: Number(value.intValue)),
								]),
							),
							links: (span.links ?? []).map(({ traceId, spanId }) => ({
								traceId,
								spanId,
							})),
							statusCode: span.status?.code ?? 0,
						})),
					),
				),
			),
		payloads: () => bodies.map((body) => body.toString("utf8")).join("\n"),
		quiet: async () => {
			const calledAt = Date.now();
			while (Date.now() - Math.max(lastExportAt, calledAt) < QUIET_MS) {
				await new Promise((resolve) => setTimeout(resolve, QUIET_MS / 5));
			}
		},
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}
