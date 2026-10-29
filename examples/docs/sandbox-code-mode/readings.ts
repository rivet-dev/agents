import { UserError } from "rivetkit";

// Fake data for the demo: one reading a minute for a week from each sensor,
// with a few planted spikes for the agent to find.
export const SENSORS = ["boiler", "pump", "intake", "exhaust", "tank"];
const READINGS = 7 * 24 * 60;
const PAGE_SIZE = 1000;
const SPIKES: Record<string, [index: number, size: number][]> = {
	boiler: [[4321, 18]],
	pump: [[7777, -14]],
	tank: [
		[1234, 22],
		[9001, 20],
	],
};

export function readingsPage(sensor: unknown, cursor: unknown = 0) {
	if (typeof sensor !== "string" || !SENSORS.includes(sensor)) throw new UserError(`Pass a sensor: ${SENSORS.join(", ")}.`);
	if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) throw new UserError("Pass 0 or the cursor from the previous page.");
	const next = cursor + PAGE_SIZE;
	return { readings: series(sensor).slice(cursor, next), next: next < READINGS ? next : null };
}

function series(sensor: string): number[] {
	const k = SENSORS.indexOf(sensor);
	let seed = k + 1;
	const random = () => {
		seed = (seed * 1103515245 + 12345) % 2 ** 31;
		return seed / 2 ** 31;
	};
	const values = Array.from({ length: READINGS }, (_, i) => {
		const daily = [2, 1, 2, 1, 0.5][k] * Math.sin((2 * Math.PI * i) / 1440);
		// The boiler and the pump share a load, so they move together.
		const load = [4, 3, 0, 0, 0][k] * Math.sin((2 * Math.PI * i) / 2000);
		const noise = random() + random() + random() - 1.5;
		return [70, 40, 15, 120, 55][k] + daily + load + noise;
	});
	for (const [index, size] of SPIKES[sensor] ?? []) values[index] += size;
	return values.map((value) => Math.round(value * 100) / 100);
}
