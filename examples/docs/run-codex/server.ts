import { setup } from "rivetkit";
import { codexSession } from "./session";

export const registry = setup({ use: { codexSession } });

registry.start();
