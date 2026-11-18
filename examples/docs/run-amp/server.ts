import { setup } from "rivetkit";
import { ampSession } from "./session";

export const registry = setup({ use: { ampSession } });

registry.start();
