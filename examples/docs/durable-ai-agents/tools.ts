import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

// docs:start search
export const searchFlights = defineTool({
	name: "search_flights",
	description: "Find flights between two airports on a date.",
	parameters: Type.Object({
		from: Type.String({ description: "Airport code, such as SFO." }),
		to: Type.String({ description: "Airport code, such as HND." }),
		date: Type.String({ description: "The date, as YYYY-MM-DD." }),
	}),
	// A search changes nothing, so running it again after a crash is harmless.
	replay: "safe",
	execute: async ({ from, to, date }) => {
		const flights = await findFlights(from, to, date);
		const text = flights.map((f) => `${f.id}: departs ${f.departs}, $${f.price}`).join("\n");
		return { output: [{ type: "text", text }], details: flights };
	},
});
// docs:end search

// docs:start book
export const bookFlight = defineTool({
	name: "book_flight",
	description: "Book a seat on a flight. Only call this after the user confirms the flight.",
	parameters: Type.Object({ flightId: Type.String(), passenger: Type.String() }),
	// After a crash this runs again with the same idempotency key, so the API books only once.
	replay: "safe",
	execute: async ({ flightId, passenger }, api, context) => {
		// The memo is saved with this tool call before the booking, so a rerun gets the same key.
		const idempotencyKey = await api.memo("idempotency-key", crypto.randomUUID(), context);
		const booking = await createBooking(flightId, passenger, idempotencyKey);
		const text = `Booked ${passenger} on ${flightId}. Confirmation ${booking.confirmation}.`;
		return { output: [{ type: "text", text }], details: booking };
	},
});
// docs:end book

// Mocks of your travel API. Replace them with calls to your own API.
async function findFlights(from: string, to: string, date: string) {
	return [
		{ id: `${from}-${to}-0810`, departs: `${date} 08:10`, price: 1240 },
		{ id: `${from}-${to}-1355`, departs: `${date} 13:55`, price: 980 },
	];
}

// Your API should return the first booking again when it sees the same idempotency key.
async function createBooking(flightId: string, passenger: string, idempotencyKey: string) {
	return { flightId, passenger, confirmation: idempotencyKey.slice(0, 6).toUpperCase() };
}
