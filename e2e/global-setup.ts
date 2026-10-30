/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { chromium, type FullConfig, type LaunchOptions } from "@playwright/test";

/**
 * Warm the dev server up before the suite runs.
 *
 * @remarks
 * Vite pre-bundles dependencies (Phaser and its plugins are large) on the first page load. The
 * dev server answers `GET /` immediately, so Playwright considers it ready while that
 * optimization is still running; a page that boots in that window receives
 * `504 (Outdated Optimize Dep)` for its dynamically imported modules and the game never mounts.
 * Vite recovers by reloading the page once optimization finishes — which is exactly what this
 * setup does, once, before any test starts. Without it the *first* test of the run fails for a
 * reason that has nothing to do with the application.
 *
 * It fails loudly if the warm-up cannot reach a mounted app, so a genuinely broken boot is never
 * masked by this retry loop.
 */
async function warmUp(config: FullConfig, attempts: number, retryDelayMs: number): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) {
    throw new Error("globalSetup: no baseURL configured for the first project");
  }

  // Reuse the project's launch options (custom executable, SwiftShader flags): without them the
  // browser has no WebGL in CI and the warm-up would fail for the wrong reason.
  const launchOptions = (config.projects[0]?.use?.launchOptions ?? {}) as LaunchOptions;
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();

  try {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await page.goto(baseURL, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => Boolean(window.__pokerogueHost__), undefined, { timeout: 120_000 });
        return;
      } catch (error) {
        lastError = error;
        // Most likely a dependency re-optimization: the next load picks up the fresh bundle.
        await page.waitForTimeout(retryDelayMs);
      }
    }

    throw new Error(`globalSetup: the app did not mount after ${attempts} attempts: ${String(lastError)}`);
  } finally {
    await browser.close();
  }
}

/**
 * Dev-server warm-up: retries, because the first load can race Vite's dependency optimization.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  await warmUp(config, 5, 2_000);
}
