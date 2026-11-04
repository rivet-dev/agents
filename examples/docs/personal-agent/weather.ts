import { obj, str } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-durable";

export const getWeather = defineTool({
	name: "get_weather",
	description: "Get the current weather in a city.",
	parameters: obj({ city: str() }),
	// A lookup changes nothing, so running it twice is harmless.
	replay: "safe",
	execute: async ({ city }) => {
		// A mock. Call a real weather API here.
		const weather = { city, temperatureC: 18, conditions: "sunny" };
		const text = `${city}: ${weather.temperatureC}°C and ${weather.conditions}.`;
		return { output: [{ type: "text", text }], details: weather };
	},
});
