import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const agent = client.agent.getOrCreate(["player-1"]);

await agent.solveChamber("1-01");
await agent.solveChamber("1-02");

console.log(await agent.solvedChambers()); // ["1-01", "1-02"]
