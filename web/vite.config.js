import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));
const themesDir = path.join(here, "src/themes");

// Reads every src/themes/<id>/theme.json so the inline boot script in
// index.html knows which themes exist before any bundle has loaded.
function readThemes() {
  return fs
    .readdirSync(themesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(themesDir, d.name, "theme.json")))
    .map((d) => JSON.parse(fs.readFileSync(path.join(themesDir, d.name, "theme.json"), "utf8")));
}

// Sets data-theme and data-mode on <html> before first paint. Keep in sync with
// src/themes/preferences.js (same storage keys, same defaults). It requests nothing:
// the fonts are bundled (src/themes/bundled-fonts.js).
const BOOT = `(function(){
  var R=document.documentElement,T=__THEMES__,D="signal-room",th,mp;
  try{th=localStorage.getItem("multiplayer-ai:theme");mp=localStorage.getItem("multiplayer-ai:mode");}catch(e){}
  if(!/^\\/(s|__fixture)\\//.test(location.pathname))th=D;
  if(!T[th])th=D;
  if(mp!=="light"&&mp!=="dark")mp="system";
  var m=mp==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):mp;
  R.setAttribute("data-theme",th);R.setAttribute("data-mode",m);R.setAttribute("data-mode-pref",mp);
  R.style.colorScheme=m;
})();`;

function themeBoot() {
  return {
    name: "multiplayer-ai-theme-boot",
    transformIndexHtml() {
      const ids = Object.fromEntries(readThemes().map((t) => [t.id, 1]));
      return [{ tag: "script", children: BOOT.replace("__THEMES__", JSON.stringify(ids)), injectTo: "head-prepend" }];
    }
  };
}

// The web app calls the orchestrator's REST wrapper (server/server.js, PORT-gated)
// at /api/tools/:name. Proxying in dev avoids CORS entirely; server.js also sets
// CORS headers directly for non-proxied/production use.
export default defineConfig({
  plugins: [react(), themeBoot()],
  server: {
    proxy: {
      "/api": {
        target: process.env.VITE_API_BASE || "http://localhost:3001",
        changeOrigin: true
      }
    }
  }
});
