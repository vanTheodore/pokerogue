/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration for the SvelteKit host application.
 *
 * This is the *only* place where the real game is exercised in a real browser:
 * the Vitest suite runs in jsdom and cannot render WebGL, so acceptance criteria
 * such as "the game starts, reaches a battle, and only one Phaser instance exists"
 * are verified here.
 *
 * Requirements:
 * - `bunx playwright install chromium` once per machine
 * - the `assets` and `locales` submodules initialised (`bun run update-submodules`)
 *
 * Run with `bun run test:e2e` (starts the SvelteKit dev server automatically).
 */
export default defineConfig({
  testDir: "./e2e",
  // Warms the dev server (first-run dependency optimization) before any test boots the game.
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  // The game boots a Phaser/WebGL app that loads thousands of atlases and typewrites its
  // messages with a per-character timer: software-rendered CI runners are slow, so the
  // timeouts are generous on purpose (flakiness here would hide real regressions).
  timeout: 240_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:8000",
    // The game registers `service-worker.js` (shipped by the assets submodule) on load. A
    // caching service worker in front of Vite's dev server serves stale module URLs, which
    // breaks the dynamic import of `src/host/boot-game.ts` ("Failed to fetch dynamically
    // imported module"). The production build is covered separately, so the suite runs without
    // a service worker.
    serviceWorkers: "block",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      // `preview.spec.ts` asserts production-artifact behaviour (cache headers, SPA fallback,
      // service worker, copied translations) that the dev server does not have by design. It
      // runs in `playwright.build.config.ts` against `build/`.
      testIgnore: ["**/preview.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
        // Escape hatch for environments where Playwright cannot download its own browser
        // (offline machines, custom Chromium builds, restricted containers). CI installs
        // the bundled Chromium and leaves this unset.
        launchOptions: {
          ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
          // Phaser needs a WebGL context. Headless Chromium has no GPU, so force ANGLE's
          // SwiftShader backend: this is a real WebGL implementation, just software-rendered
          // (the same configuration used by CI runners).
          args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
        },
      },
    },
  ],
  webServer: {
    // `--host 127.0.0.1` is explicit on purpose: without it Vite binds to `localhost`, which
    // resolves to IPv6 `::1` on Linux, and the `url` probe below (IPv4) never connects.
    command: "bun run start:kit --host 127.0.0.1",
    url: "http://127.0.0.1:8000",
    reuseExistingServer: !process.env.CI,
    // The first run also optimises Phaser and its plugins, which is slow on CI runners.
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
