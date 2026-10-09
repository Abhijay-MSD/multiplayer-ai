// npm start: check Node, install what is missing, build the web app if it is
// out of date, start the one server, and open the browser.
//
// Every command it runs is printed first, with the reason, and nothing is
// installed without that line. It uses `npm ci` (exactly what the lockfile says)
// when there is a lockfile. Plain Node, no packages, so it can run before
// anything is installed.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The floor is the first release of each line where the built-in node:sqlite module needs no flag (22.13.0, 23.4.0, and
// every 24 and newer). server/node-check.js has the same rule; a test keeps the two equal.
export const MIN_NODE_LABEL = "22.13";
const SETUP_PATH = "/setup?next=%2Fnew";

/** A readable sentence when this Node is too old, or null. */
export function nodeProblem(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map(Number);
  const tooOld = !Number.isInteger(major) || !Number.isInteger(minor) || (major >= 24 ? false : major === 23 ? minor < 4 : major === 22 ? minor < 13 : true);
  if (!tooOld) return null;
  return (
    `Multiplayer AI needs Node ${MIN_NODE_LABEL} or newer, and this is Node ${version}.\n` +
    "Older versions are untested. Install a current Node from https://nodejs.org and run npm start again."
  );
}

/**
 * `npm start -- --share=wifi` (or `--share wifi`) turns on Same Wi-Fi for this run only. Returns { value } (undefined when
 * not given), or { error } for anything else: there is no internet mode.
 */
export function shareFromArgs(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = a.startsWith("--share=") ? a.slice("--share=".length) : a === "--share" ? argv[i + 1] : undefined;
    if (value === undefined && a !== "--share") continue;
    if (value === "wifi" || value === "local") return { value };
    return { error: `--share must be wifi or local (it was "${value ?? ""}"). Sharing over the internet isn't supported.` };
  }
  return {};
}

const mtime = (p) => fs.statSync(p).mtimeMs;

/** The newest modification time under `target` (a file or a folder), ignoring node_modules and dist. */
export function newestMtime(target) {
  if (!fs.existsSync(target)) return 0;
  if (!fs.statSync(target).isDirectory()) return mtime(target);
  let newest = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (["node_modules", "dist", "dist-qa", ".results"].includes(entry.name)) continue;
    newest = Math.max(newest, newestMtime(path.join(target, entry.name)));
  }
  return newest;
}

/** Does `dir` need its packages installed? Yes when node_modules is missing or older than the lockfile. */
export function needsInstall(dir) {
  const installed = path.join(dir, "node_modules", ".package-lock.json");
  if (!fs.existsSync(path.join(dir, "node_modules"))) return true;
  const lock = path.join(dir, "package-lock.json");
  return fs.existsSync(lock) && fs.existsSync(installed) && mtime(lock) > mtime(installed);
}

export const installArgs = (dir) => (fs.existsSync(path.join(dir, "package-lock.json")) ? ["ci"] : ["install"]);

/** Does the web app need building? Yes when there is no build, or a source file is newer than it. */
export function needsBuild(webDir) {
  const built = path.join(webDir, "dist", "index.html");
  if (!fs.existsSync(built)) return true;
  const sources = ["src", "public", "index.html", "vite.config.js", "package.json", "package-lock.json"].map((p) => path.join(webDir, p));
  return Math.max(...sources.map(newestMtime)) > mtime(built);
}

/** The command that opens a link in the person's browser on this platform. */
export function openCommand(url, platform = process.platform) {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

function runNpm(args, cwd) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  return result.status === 0;
}

/**
 * Asks the operating system to open `url` in the default browser. Resolves to { ok: true }, or
 * { ok: false, reason } when there is no such command or it fails (a computer with no desktop,
 * a container). Never throws; the link is printed whatever happens.
 */
export function openBrowser(url, { platform = process.platform, spawnImpl = spawn, waitMs = 2500 } = {}) {
  const [cmd, args] = openCommand(url, platform);
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    try {
      const child = spawnImpl(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", (e) => done({ ok: false, reason: e.code === "ENOENT" ? `${cmd} isn't installed here` : `${cmd} failed: ${e.message}` }));
      child.on("exit", (code) => done(code === 0 || code === null ? { ok: true } : { ok: false, reason: `${cmd} exited with code ${code}` }));
      child.unref?.();
      setTimeout(() => done({ ok: true }), waitMs).unref?.(); // still running: the browser is starting
    } catch (e) {
      done({ ok: false, reason: e.message });
    }
  });
}

export async function main({
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  env = process.env,
  log = (line) => console.log(line),
  run = runNpm,
  open = openBrowser,
  argv = process.argv.slice(2),
  stdin = process.stdin, // when it is a terminal, pressing Enter prints and opens a fresh sign-in link
  startServer = async () => (await import(pathToFileURL(path.join(root, "server", "local.js")).href)).start({ env })
} = {}) {
  const problem = nodeProblem();
  if (problem) {
    log(problem);
    return { ok: false, reason: "node" };
  }

  const share = shareFromArgs(argv);
  if (share.error) {
    log(share.error);
    return { ok: false, reason: "share" };
  }
  if (share.value) env.MULTIPLAYER_AI_SHARE = share.value;

  const server = path.join(root, "server");
  const web = path.join(root, "web");

  for (const [dir, label] of [[server, "server"], [web, "web"]]) {
    if (!needsInstall(dir)) continue;
    const args = installArgs(dir);
    log(`\n→ npm ${args.join(" ")}   (in ${label}/)`);
    log(`  Installing the packages the ${label} part needs. This needs an internet connection and can take a minute.`);
    if (!run(args, dir)) {
      log(`\nInstalling packages for ${label}/ failed. Read the messages above; the most common cause is no internet connection.`);
      return { ok: false, reason: "install" };
    }
  }

  if (needsBuild(web)) {
    log("\n→ npm run build   (in web/)");
    log("  Building the web app, because there is no build yet or the source changed.");
    if (!run(["run", "build"], web)) {
      log("\nBuilding the web app failed. Read the messages above.");
      return { ok: false, reason: "build" };
    }
  }

  let app;
  try {
    app = await startServer();
  } catch (e) {
    log(`\n${e.message}`);
    return { ok: false, reason: "start" };
  }
  // The link carries a one-time code that signs this browser in for Setup and Settings
  // (and is removed from the address bar at once). It works once, for a few minutes. With no
  // model key set up yet it leads straight to Setup.
  const needsKey = () => app.settings?.configured?.() === false;
  const signIn = () => app.admin?.link?.(needsKey() ? SETUP_PATH : "/") ?? app.url;
  const link = signIn();
  log(`\nMultiplayer AI is running at ${app.url}`);
  if (needsKey()) log("No model key is set up yet. The link below opens Setup, where you choose a provider and paste a key.");
  log(`Sign-in link (works once, for 5 minutes):\n  ${link}`);
  log("Press Enter here for a new link, or Ctrl+C to stop Multiplayer AI.");

  // Opens `where` in the browser, and says plainly if that could not be done.
  const show = async (where) => {
    if (env.NO_OPEN) return log("(NO_OPEN is set, so the browser was not opened. Open the link above yourself.)");
    const result = await open(where);
    if (result?.ok === false) {
      log(`\nCouldn't open a browser automatically (${result.reason}). Open this link yourself; it works once, for 5 minutes:\n  ${where}`);
    } else {
      log("Opened your browser. If it didn't appear, copy the link above into it.");
    }
  };
  await show(link);

  // Only in a terminal. A pipe, a closed stdin or a detached process gets no handler, and a
  // terminal that errors or closes is ignored rather than allowed to end Multiplayer AI.
  if (stdin?.isTTY && typeof stdin.on === "function") {
    stdin.setEncoding?.("utf8");
    stdin.on("data", () => {
      const fresh = signIn();
      log(`\nNew sign-in link (works once, for 5 minutes):\n  ${fresh}`);
      if (!env.NO_OPEN) show(fresh);
    });
    stdin.on("error", () => {});
    stdin.on("end", () => {});
    stdin.resume?.();
  }
  return { ok: true, app };
}

// Run directly: npm start.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await main();
  if (!result.ok) process.exit(1);
  const stop = async () => {
    await result.app.close();
    await result.app.store.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
