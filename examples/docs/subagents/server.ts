import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";
import { askSpecialist, engineering, orders } from "./specialists";

const support = pi({ model: "anthropic/claude-opus-5-5", customTools: [askSpecialist] });

export const registry = setup({ use: { support, orders, engineering } });

registry.start();
