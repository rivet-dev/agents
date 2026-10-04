import { createFoundryLogger } from "@sandbox-agent/foundry-shared";

export const logger = createFoundryLogger({
  service: "foundry-backend",
  format: "logfmt",
});
