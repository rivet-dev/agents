import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const support = client.support.getOrCreate(["ticket-4821"]);

await support.prompt(
	"Order 1042 shows as delivered but never arrived, and the tracking page throws a 500 error. Repo: https://github.com/acme/storefront",
);
console.log(await support.getLastAssistantText());
