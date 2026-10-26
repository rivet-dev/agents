import { setup } from "rivetkit";
import { opencodeSession } from "./session";

export const registry = setup({ use: { opencodeSession } });

registry.start();
