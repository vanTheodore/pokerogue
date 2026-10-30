/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration for the **built** static artifact (`build/`).
 *
 * @remarks
 * `playwright.config.ts` runs the same specs against the Vite dev server. That is not the same
 * program the browser gets after `bun run build:preview`: the build has no dev middleware, no
 * HMR, hashed chunk names, the SPA fallback instead of dev routes, a registered (inert) service
 * worker, and translations served from a copied directory rather than from the file system.
 * Every one of those has broken a static deploy at least once somewhere, so the artifact gets
 * its own run.
 *
 * Prerequisites:
 * - `VITE_ENABLE_DEBUG_BRIDGE=1 bun run build:preview` (the specs observe the game through the
 *   bridge, which a plain production build does not ship);
 * - the `assets` and `locales` submodules checked out.
 *
 * Run with `bun run test:e2e:build`.
 */
export default defineConfig({
  testDir: "./e2e",
  // No global setup: the retry loop in the dev configuration exists for Vite's dependency
  // optimization race, which cannot happen here. A static server that fails to serve the app
  // fails the test that needed it, with the assertion that describes what was expected.
  fullyParallel: false,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:8100",
    // Unlike the dev server, the built artifact is *supposed* to register its service worker.
    // The worker shipped with the assets submodule has no `fetch` handler, so it cannot serve
    // stale modules; letting it run is the only way to notice if that ever changes.
    serviceWorkers: "allow",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium-build",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
          args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
        },
      },
    },
  ],
  webServer: {
    command: "bun scripts/preview/serve-build.ts",
    url: "http://127.0.0.1:8100",
    reuseExistingServer: !process.env.CI,
    // Serving files from disk needs no compilation; a slow start means a missing build.
    timeout: 60_000,
    env: { PORT: "8100" },
    stdout: "pipe",
    stderr: "pipe",
  },
});
