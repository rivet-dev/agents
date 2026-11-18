import { setup } from "rivetkit";
import { orchestrator } from "./orchestrator";
import { researcher } from "./researcher";
import { reviewer } from "./reviewer";

export const registry = setup({ use: { orchestrator, researcher, reviewer } });

registry.start();
