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
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:8000",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "bun run start:kit",
    url: "http://127.0.0.1:8000",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
