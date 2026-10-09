// The MCP server: Claude Code, Claude Desktop and other MCP clients start this
// process and talk to it over stdin/stdout, so nothing but MCP may be written to
// stdout. Logs go to stderr.
//
// It shares the data file with the web app (npm start); both can run at once.
// It does NOT serve HTTP unless asked (--http, or MULTIPLAYER_AI_HTTP=1), so starting
// a second copy can never fail because a port is taken.
import "./node-check.js";
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createSession }  from "./tools/create_session.js";
import { joinSession }    from "./tools/join_session.js";
import { getSession }     from "./tools/get_session.js";
import { sendDirective }  from "./tools/send_directive.js";
import { sendComment }    from "./tools/send_comment.js";
import { stepAgent } from "./tools/step_agent.js";
import { takeControl }    from "./tools/take_control.js";
import { setStatus }      from "./tools/set_status.js";
import { heartbeat }      from "./tools/heartbeat.js";
import { leaveSession }   from "./tools/leave_session.js";
import { errorBody }      from "./errors.js";
import { DEFAULTS, intSetting, trustProxyHops } from "./config.js";
import { validateEnv }    from "./env-check.js";
import { createStoreFromEnv, setDefaultStore, storeKind } from "./store/index.js";
import { createLimits, useLimits } from "./limits.js";
import { startHttp }      from "./http.js";
import { applyShareSettings } from "./share-start.js";
import os from "node:os";
import { dataDir }        from "./store/dataDir.js";
import { createSettings, insideGitRepo, setSettings } from "./settings.js";
import { installLogRedaction, redact } from "./secrets.js";

// ── Startup: the environment, the storage ────────────────────────

let kind;
try {
  kind = storeKind(process.env);
} catch (e) {
  console.error(`[multiplayer-ai] the server can't start: ${e.message}`);
  process.exit(1);
}
{
  const { errors, warnings } = validateEnv(process.env, { store: kind });
  for (const w of warnings) console.error(`[multiplayer-ai] warning: ${w}`);
  if (errors.length) {
    console.error(
      `[multiplayer-ai] the server can't start; ${errors.length} problem${errors.length === 1 ? "" : "s"} in the environment:\n` +
        errors.map((e) => `  - ${e}`).join("\n")
    );
    process.exit(1);
  }
}

let store;
try {
  store = await createStoreFromEnv(process.env);
} catch (e) {
  console.error(`[multiplayer-ai] the server can't start: ${e.message}`);
  process.exit(1);
}
setDefaultStore(store);
{
  const dir = dataDir(process.env);
  setSettings(createSettings({ dir, env: process.env }));
  installLogRedaction();
  const repo = insideGitRepo(dir);
  if (repo) console.error(`[multiplayer-ai] warning: the data folder ${dir} is inside a git repository (${repo}). It holds your saved key in settings.json; keep it out of commits.`);
}
useLimits(createLimits({ env: process.env, local: store.local }));
if (store.file) console.error(`[multiplayer-ai] data file: ${store.file}`);
if (store.migration?.backup) console.error(`[multiplayer-ai] the data file was updated to a newer layout; the old one is saved at ${store.migration.backup}`);
if (kind === "sqlite" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  console.error("[multiplayer-ai] note: Supabase settings were found, but storage is the local data file. Set MULTIPLAYER_AI_STORE=supabase to use them.");
}

// ── MCP Server ───────────────────────────────────────────────────

const mcp = new McpServer({
  name: "multiplayer-ai",
  version: "0.1.0",
  description: "Multiplayer AI session orchestrator"
});

// Wrap a tool handler: returns MCP content on success, error content on failure.
function mcpWrap(fn) {
  return async (args) => {
    try {
      const data = await fn(args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: redact(JSON.stringify(errorBody(e))) }],
        isError: true
      };
    }
  };
}

const TOKEN = z.string().describe(
  "Your access token. create_session and join_session return it once; keep it and send it with every call."
);

mcp.tool(
  "create_session",
  "Creates a new shared agent session and makes you its controller. Returns session_id, your token, and the share URL. " +
  "Keep the token: every other call needs it.",
  {
    task:         z.string().describe("The task for the agent to work on"),
    title:        z.string().optional().describe("Optional human-readable session title"),
    creator_name: z.string().describe("Display name of the session creator"),
    auto_start:   z.boolean().optional().describe(
      "If true, the agent starts answering the task straight away. Omit it to keep the default: nothing runs until step_agent is called."
    )
  },
  mcpWrap(createSession)
);

mcp.tool(
  "join_session",
  "Joins an existing session as a watcher and returns your token, the room's state and the transcript. " +
  "A name someone in the room already uses is refused with a suggestion. To come back to a room, pass your token.",
  {
    session_id: z.string().uuid().describe("Session UUID from create_session"),
    name:       z.string().describe("Display name of the person joining"),
    token:      z.string().optional().describe("Your token from an earlier join, to come back as the same person")
  },
  mcpWrap(joinSession)
);

mcp.tool(
  "get_session",
  "Returns session metadata, participants, and all events in order. Participants only.",
  {
    session_id: z.string().uuid(),
    token:      TOKEN
  },
  mcpWrap(getSession)
);

mcp.tool(
  "send_directive",
  "Sends a steering directive to the agent and queues a reply. Only the current controller can do this; " +
  "anyone else is rejected (use send_comment, or ask the controller to hand control over).",
  {
    session_id: z.string().uuid(),
    token:      TOKEN,
    content:    z.string().describe("The directive text")
  },
  mcpWrap(sendDirective)
);

mcp.tool(
  "send_comment",
  "Posts a comment to the room. Any participant can. The agent never sees it and never replies to it.",
  {
    session_id: z.string().uuid(),
    token:      TOKEN,
    content:    z.string().describe("The comment text")
  },
  mcpWrap(sendComment)
);

mcp.tool(
  "step_agent",
  "Advances the agent one step: collects pending directives, calls the model, writes the agent_message. Controller only.",
  {
    session_id: z.string().uuid(),
    token:      TOKEN
  },
  mcpWrap(stepAgent)
);

mcp.tool(
  "take_control",
  "Without `target`: take control for yourself, allowed only when nobody is controller or the controller is away. " +
  "With `target`: hand control to that participant, allowed only for the current controller, and refused if they are away.",
  {
    session_id: z.string().uuid(),
    token:      TOKEN,
    target:     z.string().optional().describe("Name of the participant to hand control to. Omit to take control yourself.")
  },
  mcpWrap(takeControl)
);

mcp.tool(
  "set_status",
  "Updates the session status: active, paused, or done. Controller only.",
  {
    session_id: z.string().uuid(),
    token:      TOKEN,
    status:     z.enum(["active", "paused", "done"])
  },
  mcpWrap(setStatus)
);

mcp.tool(
  "heartbeat",
  "Updates last_seen for you. Call every ~20 seconds to maintain presence.",
  {
    session_id: z.string().uuid(),
    token:      TOKEN
  },
  mcpWrap(heartbeat)
);

mcp.tool(
  "leave_session",
  "Marks you as away immediately (you closed the tab). Keeps your place and your token.",
  {
    session_id: z.string().uuid(),
    token:      TOKEN
  },
  mcpWrap(leaveSession)
);

// ── Optional HTTP (the web app and its API) ──────────────────────

const wantsHttp = process.argv.includes("--http") || process.env.MULTIPLAYER_AI_HTTP === "1";
if (wantsHttp) {
  // A hosted deployment (Supabase) keeps its limits, proxy settings and budget table check.
  if (!store.local) {
    const hops = trustProxyHops();
    console.error(
      "[multiplayer-ai] limits: " +
      Object.keys(DEFAULTS).map((name) => `${name}=${intSetting(name)}`).join(" ") +
      ` TRUST_PROXY_HOPS=${hops}`
    );
    const budgetTable = await store.budgetStatus();
    if (budgetTable === "missing") {
      console.error(
        "[multiplayer-ai] the server can't start: the usage_daily table is missing, so the daily step budget can't be enforced. " +
        "Run supabase/migrations/0004_usage_and_size_limits.sql in the Supabase SQL editor, then start again."
      );
      process.exit(1);
    }
    if (budgetTable === "unknown") {
      console.error("[multiplayer-ai] warning: couldn't reach the database to check for migration 0004. New steps are refused until the budget can be read.");
    }
  }
  try {
    const running = await startHttp({
      store,
      profile: store.local ? "local" : "public",
      env: process.env,
      log: (line) => console.error(line)
    });
    console.error(`[multiplayer-ai] HTTP listening on ${running.url}`);
    await applyShareSettings({ env: process.env, running, interfaces: () => os.networkInterfaces(), log: (l) => console.error(l) });
    if (store.local) console.error(`[multiplayer-ai] sign-in link for Setup and Settings (works once, for 5 minutes): ${running.admin.link()}`);
  } catch (e) {
    // The MCP server keeps working without HTTP; only the web app is unavailable.
    console.error(`[multiplayer-ai] HTTP was not started: ${e.message}`);
  }
} else {
  if (process.env.PORT) {
    console.error("[multiplayer-ai] PORT is set, but this is the MCP server and it does not serve HTTP unless asked. Pass --http to also serve the web app, or run npm start.");
  }
}

// ── Connect MCP stdio transport ───────────────────────────────────
// This is what Claude Code / Claude Desktop connect to.
// The server reads from stdin and writes to stdout, so do not log to stdout.
const transport = new StdioServerTransport();
await mcp.connect(transport);
