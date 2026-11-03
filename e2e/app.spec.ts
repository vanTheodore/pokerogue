/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, type Page, test } from "@playwright/test";
import {
  hostSnapshot,
  navigateClientSide,
  type ProbeSnapshot,
  press,
  pressUntil,
  probe,
  seedReturningPlayer,
  waitForProbe,
  waitForRunningGame,
} from "./helpers.ts";

/**
 * Acceptance tests for the SvelteKit host, run in a real Chromium against the real game.
 *
 * These cover what jsdom/Vitest cannot: WebGL rendering, the Svelte -> Phaser lifecycle in a
 * browser, the "exactly one live instance" guarantee, and a complete playable slice
 * (title screen -> starter choice -> first battle).
 *
 * Prerequisites: see `e2e/README.md` (initialised `assets` submodule and a Chromium build).
 */

/** Uncaught page errors collected for the current test. */
let pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await seedReturningPlayer(page);
});

/** Boot the game and fail fast (with the host error) if it cannot start. */
async function bootGame(page: Page): Promise<void> {
  await page.goto("/");
  await waitForRunningGame(page);
}

/**
 * Advance from boot to the title screen.
 *
 * @remarks
 * A first run shows the intro tutorial pages and then asks for the player's gender
 * (`SelectGenderPhase`); both are dismissed with SUBMIT. Rather than hard-coding how many
 * presses that takes (it depends on the locale's text length and the runner's speed), this
 * presses until the title screen is actually reached.
 */
async function reachTitleScreen(page: Page) {
  return await pressUntil(
    page,
    "Enter",
    snapshot => snapshot.phase === "TitlePhase" || snapshot.uiModeName === "TITLE",
    "the title screen",
    { maxPresses: 60, timeout: 180_000 },
  );
}

test.describe("SvelteKit host", () => {
  test("boots exactly one Phaser instance inside #app", async ({ page }) => {
    await bootGame(page);

    expect((await hostSnapshot(page)).instancesCreated).toBe(1);

    // One canvas, owned by #app, and it is the only one in the document.
    await expect(page.locator("#app canvas")).toHaveCount(1);
    await expect(page.locator("canvas")).toHaveCount(1);

    expect(pageErrors).toEqual([]);
  });

  test("reaches the title screen", async ({ page }) => {
    await bootGame(page);

    const title = await reachTitleScreen(page);

    expect(["TitlePhase"]).toContain(title.phase);
    expect(pageErrors).toEqual([]);
  });

  test("loads the game fonts and renders the touch control shell", async ({ page }) => {
    await bootGame(page);

    // The pixel font is loaded through the SvelteKit asset pipeline; if it failed the game
    // would render with a fallback font and this check would catch it.
    expect(await page.evaluate(() => document.fonts.check('16px "emerald"'))).toBe(true);

    await expect(page.locator("#touchControls")).toBeAttached();
    await expect(page.locator("#touchControls [data-key]").first()).toBeAttached();
  });

  test("does not duplicate the canvas across reloads", async ({ page }) => {
    await bootGame(page);
    await page.reload();
    await waitForRunningGame(page);

    await expect(page.locator("canvas")).toHaveCount(1);
    // A reload is a fresh document: the counter restarts at one instance.
    expect((await hostSnapshot(page)).instancesCreated).toBe(1);
  });

  /**
   * A client-side navigation unmounts and remounts the page component *within the same
   * document*. This is the case a naive `onMount`/`onDestroy` pair gets wrong: the unmount's
   * teardown can destroy the instance the freshly mounted component already uses, or leak a
   * second Phaser instance. Reloading the page does not test this (see the test above).
   */
  test("keeps a single game across a client-side navigation (remount)", async ({ page }) => {
    await bootGame(page);
    await reachTitleScreen(page);
    const before = await hostSnapshot(page);

    await navigateClientSide(page, "/about");
    // The canvas must disappear while the game route is unmounted...
    await expect(page.locator("canvas")).toHaveCount(0);

    await navigateClientSide(page, "/");
    await waitForProbe(page, snapshot => snapshot.phase === "TitlePhase", "the title screen again", 180_000);

    // ...and come back as a single, live instance.
    await expect(page.locator("canvas")).toHaveCount(1);
    const after = await hostSnapshot(page);
    expect(after.status).toBe("running");
    expect(after.instancesCreated).toBe(before.instancesCreated + 1);
    expect(after.activeLeases).toBe(1);
    // Behaviour, not implementation: no duplicate canvases and no leaked leases.
    await expect(page.locator("canvas")).toHaveCount(1);
    expect(pageErrors).toEqual([]);
  });
});

test.describe("Gameplay", () => {
  test("plays from the title screen into the first battle", async ({ page }) => {
    test.slow();

    await bootGame(page);
    await reachTitleScreen(page);

    // Title -> "New Game" -> "Classic".
    await pressUntil(
      page,
      "Enter",
      snapshot => snapshot.uiModeName === "OPTION_SELECT" || snapshot.uiModeName === "STARTER_SELECT",
      "the game mode menu",
    );
    const starterSelect = await pressUntil(
      page,
      "Enter",
      snapshot => snapshot.uiModeName === "STARTER_SELECT",
      "the starter selection screen",
    );
    expect(starterSelect.partySize).toBe(0);

    // Pick the first starter: ACTION opens its menu, Enter chooses "Add to party".
    await pressUntil(page, " ", snapshot => snapshot.uiModeName === "OPTION_SELECT", "the starter action menu");
    await pressUntil(page, "Enter", snapshot => snapshot.uiModeName === "STARTER_SELECT", "the starter menu to close");

    // Confirm the party (SUBMIT) and advance the battle intro messages.
    const inRun = await pressUntil(
      page,
      "Enter",
      snapshot => snapshot.uiModeName === "COMMAND" && snapshot.waveIndex !== null,
      "the battle command menu",
      { maxPresses: 60, timeout: 180_000 },
    );
    expect(inRun.waveIndex).toBe(1);
    expect(inRun.partySize).toBe(1);

    // First battle: FIGHT -> first move.
    expect(inRun.turn).toBe(1);

    await pressUntil(page, "Enter", snapshot => snapshot.uiModeName === "FIGHT", "the move selection menu");
    const beforeMove = (await probe(page))!;
    expect(beforeMove.enemyHp).toBeGreaterThan(0);

    await press(page, "Enter", 1_500);

    /** Menus in which SUBMIT means "commit this choice" rather than "advance a message". */
    const isChoiceMenu = (snapshot: ProbeSnapshot): boolean =>
      snapshot.uiModeName === "COMMAND" || snapshot.uiModeName === "FIGHT" || snapshot.uiModeName === "TARGET_SELECT";

    /**
     * Wait for a *terminal* battle state, never a transitional one.
     *
     * @remarks
     * An earlier version accepted "left `CommandPhase`", which becomes true the instant the
     * move animation starts and therefore proves nothing about the move resolving. Only two
     * states are accepted here, and both are reachable only after the whole turn — both
     * sides' moves included — has resolved:
     *
     * - back at the player's command menu with the turn counter advanced. `Battle.turn` is
     *   incremented by `TurnEndPhase`, which is queued after every move of the turn;
     * - the encounter is over: the enemy party is empty or the run moved to another wave.
     */
    const turnResolved = (snapshot: ProbeSnapshot): boolean => {
      const nextTurn = snapshot.turn !== null && snapshot.turn > (beforeMove.turn ?? 0);
      const backToPlayer = snapshot.phase === "CommandPhase" && snapshot.uiModeName === "COMMAND";
      const encounterOver =
        snapshot.phase !== "MovePhase"
        && (snapshot.enemyPartySize === 0 || (snapshot.waveIndex ?? 0) > (beforeMove.waveIndex ?? 0));

      return (nextTurn && backToPlayer) || encounterOver;
    };

    /**
     * Choose until the turn ends, pressing SUBMIT in every choice menu.
     *
     * @remarks
     * The first encounter is not always a single battle: a double battle asks for a target
     * (`TARGET_SELECT`) after the move is picked, and asks the second Pokémon of the party to
     * choose afterwards (`COMMAND` → `FIGHT` → move). A player keeps pressing until the turn
     * ends; doing the same here keeps the test about *the battle resolving* instead of about
     * the exact sequence of menus a particular encounter happens to show.
     */
    const deadline = Date.now() + 180_000;
    let current = (await probe(page))!;
    while (!turnResolved(current) && Date.now() < deadline) {
      if (isChoiceMenu(current)) {
        await press(page, "Enter", 2_000);
      } else {
        await page.waitForTimeout(1_000);
      }
      current = (await probe(page))!;
    }

    const afterFirstTurn = await waitForProbe(page, turnResolved, "the first turn to resolve", 60_000);

    // A move really ran: PP is spent when a move is used, whatever the outcome (hit, miss or
    // a type immunity), so this cannot be satisfied by a UI transition.
    const ppBefore = beforeMove.leadMovePpUsed.reduce((sum, pp) => sum + pp, 0);
    const ppAfter = afterFirstTurn.leadMovePpUsed.reduce((sum, pp) => sum + pp, 0);
    expect(ppAfter, "the selected move did not consume PP, so it never ran").toBe(ppBefore + 1);

    // The battle state is a real one, not a half-initialised snapshot.
    expect(afterFirstTurn.playerHp).not.toBeNull();
    expect(afterFirstTurn.playerMaxHp).toBeGreaterThan(0);
    expect(afterFirstTurn.enemyHp).toBeGreaterThanOrEqual(0);
    expect(afterFirstTurn.enemyHp).toBeLessThanOrEqual(afterFirstTurn.enemyMaxHp!);

    // Guest saves are written as the run starts; the build-only spec covers restoral.
    const savedSlots = await page.evaluate(() =>
      Object.keys(localStorage).filter(key => key.startsWith("sessionData") || key.startsWith("data_")),
    );
    expect(savedSlots.length).toBeGreaterThan(0);

    // Keep the outcome in the report so a failure is diagnosable from the CI log alone.
    test.info().annotations.push({
      type: "first turn",
      description: JSON.stringify({
        turn: [beforeMove.turn, afterFirstTurn.turn],
        enemyHp: [beforeMove.enemyHp, afterFirstTurn.enemyHp],
        playerHp: [beforeMove.playerHp, afterFirstTurn.playerHp],
        phase: afterFirstTurn.phase,
        wave: afterFirstTurn.waveIndex,
      }),
    });

    expect(pageErrors).toEqual([]);
  });
});
