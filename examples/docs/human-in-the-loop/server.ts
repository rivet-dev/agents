import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";
import { approval, deploy } from "./deploy";

const agent = pi({ model: "anthropic/claude-opus-5-5", customTools: [deploy] });

export const registry = setup({ use: { agent, approval } });

registry.start();
