// Imported first by server.js (after dotenv): validates the environment before
// any other module reads it. Logs go to stderr because stdout belongs to MCP.
import { validateEnv } from "./env-check.js";

const { errors, warnings } = validateEnv(process.env);
for (const w of warnings) console.error(`[multiplayer-ai] warning: ${w}`);
if (errors.length) {
  console.error(
    `[multiplayer-ai] the server can't start; ${errors.length} problem${errors.length === 1 ? "" : "s"} in the environment:\n` +
      errors.map((e) => `  - ${e}`).join("\n")
  );
  process.exit(1);
}
