import { db } from "rivetkit/db/drizzle";
import * as schema from "./schema.js";
import migrations from "./migrations.js";

export const githubDataDb = db({ schema, migrations });
