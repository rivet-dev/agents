import { setup } from "rivetkit";
import { chatAgent } from "./chat-agent";

export const registry = setup({ use: { chatAgent } });

registry.start();
