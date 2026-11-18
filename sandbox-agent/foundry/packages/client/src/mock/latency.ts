const MOCK_LATENCY_MIN_MS = 1;
const MOCK_LATENCY_MAX_MS = 200;

export function randomMockLatencyMs(): number {
  return Math.floor(Math.random() * (MOCK_LATENCY_MAX_MS - MOCK_LATENCY_MIN_MS + 1)) + MOCK_LATENCY_MIN_MS;
}

export function injectMockLatency(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, randomMockLatencyMs());
  });
}
