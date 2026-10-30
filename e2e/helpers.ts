/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, type Page } from "@playwright/test";

/**
 * Helpers shared by the end-to-end suite.
 *
 * @remarks
 * The game is driven the way a player drives it (keyboard input) and observed through the
 * development-only bridge in `src/host/game-host.ts`. No gameplay code is stubbed: the
 * suite runs the real scenes, the real battle logic and the real Svelte lifecycle.
 *
 * The only fixtures are:
 * - `settings` seeded in `localStorage` as a returning player's preferences (tutorials
 *   disabled, gender already chosen, silent audio). These are user preferences, not game
 *   logic: without them every test would first replay the first-run tutorial text and the
 *   gender prompt, which only slows the suite down and covers nothing the unit tests do not.
 * - rendered assets, which come from the `assets` submodule (see `e2e/README.md`).
 */

/** Observable state of the running game (mirrors `PokerogueProbe`). */
export interface ProbeSnapshot {
  ready: boolean;
  phase: string | null;
  uiMode: number | null;
  uiModeName: string | null;
  waveIndex: number | null;
  partySize: number;
  turn: number | null;
  enemyHp: number | null;
}

/** Observable state of the host (mirrors `GameHostSnapshot`). */
export interface HostSnapshot {
  status: "idle" | "starting" | "running" | "failed";
  error: string | null;
  instancesCreated: number;
  activeLeases: number;
}

declare global {
  interface Window {
    __pokerogueHost__?: {
      snapshot(): HostSnapshot;
      probe(): Promise<ProbeSnapshot | null>;
      navigate(path: string): Promise<void>;
      game(): {
        scene: { getScenes(active?: boolean): { scene: { key: string; isActive(): boolean } }[] };
      } | null;
    };
  }
}

/** Boot timeout: the first load compiles the dev bundle and loads every atlas. */
export const BOOT_TIMEOUT_MS = 180_000;

/** Default timeout for a single in-game transition (software WebGL is slow). */
export const STEP_TIMEOUT_MS = 90_000;

/**
 * Seed the preferences of a returning player before the app boots.
 *
 * @remarks
 * Settings are merged per category with the game's defaults
 * (`SettingsManager.loadFromLocalStorage`), so only the changed keys are needed here.
 * `PlayerGender.MALE` is `1`; the gender prompt only appears while it is `UNSET`.
 *
 * `gameVersion` is set above the current one so the settings migrators are skipped: they
 * assume a full save file (`meta.gameVersion`) and would throw on this partial object.
 */
export async function seedReturningPlayer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem(
      "settings",
      JSON.stringify({
        // Prevents `applySettingsVersionMigration` from running (see the doc comment above).
        gameVersion: "99.9.9",
        general: {
          enableTutorials: false,
          playerGender: 1,
        },
        audio: {
          BGM_Volume: 0,
          SFX_Volume: 0,
          field_BGM_Volume: 0,
          field_SFX_Volume: 0,
          SE_Volume: 0,
        },
      }),
    );
  });
}

/** Read the current host snapshot. */
export function hostSnapshot(page: Page): Promise<HostSnapshot> {
  return page.evaluate(() => window.__pokerogueHost__!.snapshot());
}

/** Read the current game probe, or `null` while the game is not ready yet. */
export function probe(page: Page): Promise<ProbeSnapshot | null> {
  return page.evaluate(async () => (window.__pokerogueHost__ ? await window.__pokerogueHost__.probe() : null));
}

/**
 * Wait for the host to reach a terminal boot state and assert it succeeded.
 *
 * @param page - The page under test
 */
export async function waitForRunningGame(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const status = window.__pokerogueHost__?.snapshot().status;
      // The bridge only exists once the page component is mounted, so an absent bridge is
      // "not started yet", not "started".
      return status === "running" || status === "failed";
    },
    undefined,
    { timeout: BOOT_TIMEOUT_MS },
  );

  const snapshot = await hostSnapshot(page);
  expect(snapshot.error, `game failed to boot: ${snapshot.error}`).toBeNull();
  expect(snapshot.status).toBe("running");
}

/**
 * Wait until the probe satisfies `predicate`.
 *
 * @param page - The page under test
 * @param predicate - Condition evaluated in Node against the probe snapshot
 * @param description - Human readable description used in the failure message
 * @param timeout - Maximum wait in milliseconds
 * @returns The matching probe snapshot
 */
export async function waitForProbe(
  page: Page,
  predicate: (snapshot: ProbeSnapshot) => boolean,
  description: string,
  timeout = STEP_TIMEOUT_MS,
): Promise<ProbeSnapshot> {
  const deadline = Date.now() + timeout;
  let latest: ProbeSnapshot | null = null;

  while (Date.now() < deadline) {
    latest = await probe(page);
    if (latest && predicate(latest)) {
      return latest;
    }
    await page.waitForTimeout(250);
  }

  throw new Error(`Timed out waiting for ${description}. Last state: ${JSON.stringify(latest)}`);
}

/**
 * Press `key` repeatedly until the game reaches the expected state.
 *
 * @remarks
 * The game ignores input while a message is still typing and during transitions, so a fixed
 * number of presses is not reliable (and would make the suite flaky on slow CI runners).
 * Pressing until the state is reached mirrors what a player does.
 *
 * @param page - The page under test
 * @param key - Playwright key to press (`"Enter"`, `" "`, `"ArrowDown"`, ...)
 * @param predicate - Condition that marks the transition as complete
 * @param description - Human readable description used in the failure message
 * @param options - `maxPresses` and `timeout` tuning
 * @returns The matching probe snapshot
 */
export async function pressUntil(
  page: Page,
  key: string,
  predicate: (snapshot: ProbeSnapshot) => boolean,
  description: string,
  {
    maxPresses = 40,
    timeout = STEP_TIMEOUT_MS,
    settleMs = 2_500,
  }: { maxPresses?: number; timeout?: number; settleMs?: number } = {},
): Promise<ProbeSnapshot> {
  const deadline = Date.now() + timeout;

  for (let press = 0; press < maxPresses && Date.now() < deadline; press++) {
    const current = await probe(page);
    if (current && predicate(current)) {
      return current;
    }

    await page.keyboard.press(key);
    // Long enough for the typewriter/tween of the *current* step to finish before the next
    // press: pressing while the game is still animating is ignored, and a tight loop would
    // spend its press budget doing nothing on a slow software-rendered runner.
    await page.waitForTimeout(settleMs);
  }

  return await waitForProbe(page, predicate, description, Math.max(1_000, deadline - Date.now()));
}

/** Press a key once and let the game react. */
export async function press(page: Page, key: string, settleMs = 600): Promise<void> {
  await page.keyboard.press(key);
  await page.waitForTimeout(settleMs);
}

/** Navigate to the game with a SvelteKit client-side transition (no page reload). */
export async function navigateClientSide(page: Page, path: string): Promise<void> {
  await page.evaluate(async path => await window.__pokerogueHost__!.navigate(path), path);
}
