// The "npm start" server: the whole app in one process. Opens the data file,
// serves the web app and the API on 127.0.0.1, and does not speak MCP.
// (node server/server.js is the MCP server; see server.js.)
import "./node-check.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { validateEnv } from "./env-check.js";
import { createStoreFromEnv, setDefaultStore, storeKind } from "./store/index.js";
import { dataDir } from "./store/dataDir.js";
import { createSettings, insideGitRepo, setSettings } from "./settings.js";
import { installLogRedaction } from "./secrets.js";
import { containerMode } from "./container.js";
import { attachFreshLinkHandlers, signInTarget } from "./signin-prompt.js";
import { applyShareSettings } from "./share-start.js";
import os from "node:os";
import { createLimits, useLimits } from "./limits.js";
import { startHttp } from "./http.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Variables from server/.env, if that file exists, for people who already use one. The real
 * environment wins. MULTIPLAYER_AI_NO_DOTENV=1 skips the file: for tests, and for images that have none.
 */
function loadOptionalDotenv(env) {
  const file = path.join(HERE, ".env");
  if (String(env.MULTIPLAYER_AI_NO_DOTENV ?? "") === "1") return;
  if (fs.existsSync(file)) dotenv.config({ path: file, processEnv: env, override: false, quiet: true });
}

export async function start({
  env = process.env,
  log = (l) => console.log(l),
  port,
  webDir,
  interfaces = () => os.networkInterfaces(), // this computer's network addresses (a stand-in in tests)
  detectContainer // a stand-in in tests
} = {}) {
  loadOptionalDotenv(env);
  const kind = storeKind(env);
  const { errors, warnings } = validateEnv(env, { store: kind });
  for (const w of warnings) log(`[multiplayer-ai] warning: ${w}`);
  if (errors.length) {
    throw new Error(
      `Multiplayer AI can't start; ${errors.length} problem${errors.length === 1 ? "" : "s"} in the environment:\n` + errors.map((e) => `  - ${e}`).join("\n")
    );
  }

  const store = await createStoreFromEnv(env);
  setDefaultStore(store);
  const dir = dataDir(env);
  const settings = createSettings({ dir, env });
  setSettings(settings);
  installLogRedaction();
  const repo = insideGitRepo(dir);
  if (repo) {
    log(
      `[multiplayer-ai] warning: the data folder ${dir} is inside a git repository (${repo}). It holds your saved key in settings.json. ` +
      "Keep it out of commits: add it to .gitignore, or move it with MULTIPLAYER_AI_DATA_DIR."
    );
  }
  if (settings.problem()) log(`[multiplayer-ai] warning: ${settings.problem()}`);
  useLimits(createLimits({ env, local: store.local }));
  if (store.migration?.backup) log(`[multiplayer-ai] the data file was updated to a newer layout; the old one is saved at ${store.migration.backup}`);
  if (store.file) log(`[multiplayer-ai] data file: ${store.file}`);
  if (kind === "sqlite" && env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    log("[multiplayer-ai] note: Supabase settings were found, but storage is the local data file. Set MULTIPLAYER_AI_STORE=supabase to use them.");
  }

  const mode = containerMode(env, detectContainer);
  if (mode.ignored) log("[multiplayer-ai] warning: MULTIPLAYER_AI_CONTAINER is set, but this does not look like a container, so it is ignored.");
  const running = await startHttp({ store, profile: "local", env, port, webDir, settings, dataDir: dir, container: mode.on, interfaces, log: (l) => log(l) });
  await applyShareSettings({ env, running, interfaces, log });
  return { ...running, store, settings };
}

// Run directly (node server/local.js, and what the Docker image runs): start, print the
// address and the sign-in link, and stay up.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = await start();
    console.log(`Multiplayer AI is running at ${app.url}`);
    if (app.container) {
      console.log(
        "Running in a container. Connections from your computer arrive through Docker's network, so Multiplayer AI cannot tell that they\n" +
        "come from this computer. Setup and Settings are protected by the sign-in link below (single use, 5 minutes) and the cookie\n" +
        "it sets: nothing in them works without both. Publish the port on your own computer only: -p 127.0.0.1:3737:3737"
      );
    }
    if (!app.settings.configured()) console.log("No model key is set up yet. The link below opens Setup, where you choose a provider and paste a key.");
    console.log(`Sign-in link (works once, for 5 minutes):\n  ${app.admin.link(signInTarget(app.settings))}`);
    console.log(process.stdin.isTTY ? "Press Enter here for a new link, or Ctrl+C to stop." : "For a new link, send this process SIGUSR2 (with Docker: docker kill -s USR2 <container name>).");
    attachFreshLinkHandlers({
      link: () => app.admin.link(signInTarget(app.settings)),
      onLink: (link) => console.log(`\nNew sign-in link (works once, for 5 minutes):\n  ${link}`)
    });
    const stop = async () => {
      await app.close();
      await app.store.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
