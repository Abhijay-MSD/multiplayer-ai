import { defineConfig, devices } from "@playwright/test";

// QA runs against a production build served by `vite preview`, with the
// /__fixture/ test pages switched on (VITE_FIXTURES=1). The fixture pages are
// the real room components fed from web/qa/fixtures, so no database is needed.
//
// This folder has its own package.json, so the browser-test packages are not
// part of the install that npm start does. Run from web/qa: npm ci, then npm test.
const PORT = 5199;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.js/,
  outputDir: "./.results",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["Desktop Chrome"],
    reducedMotion: "reduce"
  },
  webServer: {
    // The app is built and served from web/, one folder up, with web's own packages.
    command: `VITE_FIXTURES=1 npx vite build --outDir dist-qa --emptyOutDir && npx vite preview --outDir dist-qa --port ${PORT} --strictPort`,
    cwd: "..",
    url: `http://localhost:${PORT}/__fixture/name`,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
