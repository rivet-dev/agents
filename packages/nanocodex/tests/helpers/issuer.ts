import { createServer } from "node:http";

/** An unsigned JWT; nanocodex reads only its claims. */
export function jwt(claims: Record<string, unknown>): string {
	return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

/**
 * A local ChatGPT OAuth issuer. Each refresh returns a new access token and
 * rotates the refresh token; reusing an old refresh token fails, as it does
 * at auth.openai.com.
 */
export async function startIssuer() {
	let current = "refresh-1";
	let refreshes = 0;
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", async () => {
			if (request.url !== "/oauth/token") {
				response.writeHead(404).end();
				return;
			}
			const { refresh_token: refreshToken } = JSON.parse(body);
			// Widens the window in which two refreshes would overlap.
			await new Promise((resolve) => setTimeout(resolve, 200));
			if (refreshToken !== current) {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "refresh_token_reused" }));
				return;
			}
			refreshes += 1;
			current = `refresh-${refreshes + 1}`;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					access_token: accessToken(refreshes),
					refresh_token: current,
				}),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) {
		throw new Error("issuer has no address");
	}
	return {
		url: `http://127.0.0.1:${address.port}`,
		get refreshes() {
			return refreshes;
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** The access token the issuer returns for its `generation`th refresh. */
export function accessToken(generation: number): string {
	return jwt({ exp: Math.floor(Date.now() / 1000) + 3600, generation });
}
