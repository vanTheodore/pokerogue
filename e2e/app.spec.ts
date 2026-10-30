/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, type Page, test } from "@playwright/test";

/**
 * Shape of the development-only debug bridge installed by `src/host/game-host.ts`.
 * Declared here (instead of importing game types) so the E2E suite stays independent
 * of the game's TypeScript project.
 */
interface PhaserSceneKey {
  scene: { key: string };
}

interface PhaserGameHandle {
  scene: {
    getScenes(active?: boolean): PhaserSceneKey[];
    isActive(key: string): boolean;
  };
}

interface GameHostBridge {
  snapshot(): { status: "idle" | "starting" | "running" | "failed"; error: string | null; instancesCreated: number };
  game(): PhaserGameHandle | null;
}

declare global {
  interface Window {
    __pokerogueHost__?: GameHostBridge;
  }
}

/**
 * Acceptance tests for the SvelteKit host, run in a real Chromium against the real game.
 *
 * These cover the criteria that jsdom/Vitest cannot: WebGL rendering, the Svelte ->
 * Phaser lifecycle in a browser, and the "no duplicate instance" guarantee.
 *
 * Prerequisites: initialized `assets`/`locales` submodules and
 * `bunx playwright install chromium`.
 */

/** Uncaught page errors collected for the current test. */
let pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
});

/** Wait until the host has a running game instance (failing fast on a boot error). */
async function waitForGame(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const host = window.__pokerogueHost__;
      if (!host) {
        return false;
      }
      const { status } = host.snapshot();
      return status === "running" || status === "failed";
    },
    undefined,
    { timeout: 120_000 },
  );

  const snapshot = await page.evaluate(() => window.__pokerogueHost__!.snapshot());
  expect(snapshot.error, `game failed to boot: ${snapshot.error}`).toBeNull();
  expect(snapshot.status).toBe("running");
}

/** Wait until `LoadingScene` has handed over to `BattleScene` (the title screen). */
async function waitForTitleScreen(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const game = window.__pokerogueHost__?.game();
      return Boolean(game && game.scene.isActive("battle") && !game.scene.isActive("loading"));
    },
    undefined,
    { timeout: 120_000 },
  );
}

test.describe("SvelteKit host", () => {
  test("boots exactly one Phaser instance inside #app", async ({ page }) => {
    await page.goto("/");
    await waitForGame(page);

    const snapshot = await page.evaluate(() => window.__pokerogueHost__!.snapshot());
    expect(snapshot.instancesCreated).toBe(1);

    // One canvas, owned by #app, and it is the only one in the document.
    await expect(page.locator("#app canvas")).toHaveCount(1);
    await expect(page.locator("canvas")).toHaveCount(1);

    expect(pageErrors).toEqual([]);
  });

  test("starts both scenes and reaches the title screen", async ({ page }) => {
    await page.goto("/");
    await waitForGame(page);

    const scenes = await page.evaluate(() => {
      const game = window.__pokerogueHost__!.game()!;
      return game.scene.getScenes(false).map(scene => scene.scene.key);
    });

    expect(scenes).toContain("loading");
    expect(scenes).toContain("battle");

    await waitForTitleScreen(page);
    expect(pageErrors).toEqual([]);
  });

  test("loads the game fonts and serves the touch control shell", async ({ page }) => {
    await page.goto("/");
    await waitForGame(page);

    expect(await page.evaluate(() => document.fonts.check('16px "emerald"'))).toBe(true);
    await expect(page.locator("#touchControls")).toBeAttached();
    await expect(page.locator("#touchControls [data-key]").first()).toBeAttached();
  });

  test("does not duplicate the canvas across reloads", async ({ page }) => {
    await page.goto("/");
    await waitForGame(page);
    await page.reload();
    await waitForGame(page);

    await expect(page.locator("canvas")).toHaveCount(1);
    expect((await page.evaluate(() => window.__pokerogueHost__!.snapshot())).instancesCreated).toBe(1);
  });

  test("accepts keyboard input on the title screen without errors", async ({ page }) => {
    await page.goto("/");
    await waitForGame(page);
    await waitForTitleScreen(page);

    // Advancing the title screen must not throw and must keep a single canvas alive.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2_000);

    await expect(page.locator("canvas")).toHaveCount(1);
    expect(pageErrors).toEqual([]);
  });
});
