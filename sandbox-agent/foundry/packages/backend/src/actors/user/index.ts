import { actor } from "rivetkit";
import { userDb } from "./db/db.js";
import { betterAuthActions } from "./actions/better-auth.js";
import { userActions } from "./actions/user.js";

export const user = actor({
  db: userDb,
  options: {
    name: "User",
    icon: "shield",
    actionTimeout: 60_000,
  },
  createState: (_c, input: { userId: string }) => ({
    userId: input.userId,
  }),
  actions: {
    ...betterAuthActions,
    ...userActions,
  },
});
