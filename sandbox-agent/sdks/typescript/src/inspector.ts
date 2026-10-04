export interface InspectorUrlOptions {
  /**
   * Base URL of the sandbox-agent server.
   */
  baseUrl: string;
  /**
   * Optional bearer token for authentication.
   */
  token?: string;
  /**
   * Optional extra headers to pass to the sandbox-agent server.
   * Will be JSON-encoded in the URL.
   */
  headers?: Record<string, string>;
}

/**
 * Builds a URL to the sandbox-agent inspector UI with the given connection parameters.
 * The inspector UI is served at /ui/ on the sandbox-agent server.
 */
export function buildInspectorUrl(options: InspectorUrlOptions): string {
  const normalized = options.baseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (options.token) {
    params.set("token", options.token);
  }
  if (options.headers && Object.keys(options.headers).length > 0) {
    params.set("headers", JSON.stringify(options.headers));
  }
  const queryString = params.toString();
  return `${normalized}/ui/${queryString ? `?${queryString}` : ""}`;
}
