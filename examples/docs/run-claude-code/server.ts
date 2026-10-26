import { setup } from "rivetkit";
import { claudeSession } from "./session";

export const registry = setup({ use: { claudeSession } });

registry.start();
