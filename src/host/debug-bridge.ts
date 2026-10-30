/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { type GameHostSnapshot, gameHost } from "./game-host";

/**
 * Browser-side observation bridge used by the Playwright acceptance suite (`e2e/`).
 *
 * @remarks
 * This module exists so that the E2E suite can *observe* the game — and navigate the way an
 * in-app link does — without exposing anything in production and without adding UI that only
 * tests use:
 *
 * - it is only installed when the page component runs in development (`import.meta.env.DEV`);
 * - nothing is installed as a side effect of importing the host: the page calls
 *   {@linkcode installDebugBridge} on mount, so unit tests never touch `window`;
 * - `$app/navigation` is imported here (not in `game-host.ts`) so the Vitest suite, which does
 *   not run SvelteKit's plugin, never has to resolve SvelteKit virtual modules.
 *
 * The bridge never *drives* the game: all input still goes through the keyboard, like a player.
 */

/** Observable game state used by the E2E suite. */
export interface PokerogueProbe {
  /** `true` once the scene and its UI exist. */
  readonly ready: boolean;
  /** Name of the phase currently being executed (`"TitlePhase"`, `"CommandPhase"`, ...). */
  readonly phase: string | null;
  /** Numeric `UiMode` currently displayed. */
  readonly uiMode: number | null;
  /** Name of the `UiMode` currently displayed (`"TITLE"`, `"STARTER_SELECT"`, ...). */
  readonly uiModeName: string | null;
  /** Current wave index, `null` before a run starts. */
  readonly waveIndex: number | null;
  /** Number of Pokémon in the player's party. */
  readonly partySize: number;
  /** Number of turns elapsed in the current battle, `null` outside of one. */
  readonly turn: number | null;
  /** Current HP of the first enemy Pokémon, `null` outside of a battle. */
  readonly enemyHp: number | null;
  /** Max HP of the first enemy Pokémon, `null` outside of a battle. */
  readonly enemyMaxHp: number | null;
  /** Current and max HP of the player's lead Pokémon, `null` before the run starts. */
  readonly playerHp: number | null;
  readonly playerMaxHp: number | null;
  /** How many Pokémon the enemy still has, `null` outside of a battle. */
  readonly enemyPartySize: number | null;
  /**
   * PP consumed by each move of the player's lead Pokémon.
   *
   * @remarks
   * PP is spent when a move is used, whatever the outcome (miss, immunity, immunity to the
   * type, ...), so a change here proves the move was actually executed rather than that the UI
   * merely left its menu.
   */
  readonly leadMovePpUsed: readonly number[];
}

/** Shape exposed on `window.__pokerogueHost__` in development builds. */
export interface PokerogueDebugBridge {
  /** Lifecycle snapshot of the host (status, error, instances created, leases). */
  snapshot: () => GameHostSnapshot;
  /** Live `Phaser.Game`, or `null` while nothing is running. */
  game: () => unknown;
  /** Current game state, or `null` before the scene is ready. */
  probe: () => Promise<PokerogueProbe | null>;
  /** SvelteKit client-side navigation (mount/unmount without a page load). */
  navigate: (path: string) => Promise<void>;
}

declare global {
  interface Window {
    __pokerogueHost__?: PokerogueDebugBridge;
  }
}

/**
 * Install the bridge on `window`, if the current build is a development build.
 *
 * @remarks
 * Idempotent: re-installing (HMR) simply replaces the previous object with a fresh one that
 * points at the same singleton host.
 */
export function installDebugBridge(): void {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return;
  }

  const bridge: PokerogueDebugBridge = {
    snapshot: () => gameHost.snapshot,
    game: () => gameHost.game,
    probe: async (): Promise<PokerogueProbe | null> => {
      const [{ globalScene }, { UiMode }] = await Promise.all([import("#app/global-scene"), import("#enums/ui-mode")]);

      if (!globalScene?.ui) {
        return null;
      }

      return {
        ready: true,
        phase: globalScene.phaseManager?.getCurrentPhase()?.phaseName ?? null,
        uiMode: globalScene.ui.mode,
        uiModeName: UiMode[globalScene.ui.mode] ?? null,
        waveIndex: globalScene.currentBattle?.waveIndex ?? null,
        partySize: globalScene.getPlayerParty?.().length ?? 0,
        turn: globalScene.currentBattle?.turn ?? null,
        enemyHp: globalScene.getEnemyParty?.()[0]?.hp ?? null,
        enemyMaxHp: globalScene.getEnemyParty?.()[0]?.getMaxHp() ?? null,
        playerHp: globalScene.getPlayerParty?.()[0]?.hp ?? null,
        playerMaxHp: globalScene.getPlayerParty?.()[0]?.getMaxHp() ?? null,
        enemyPartySize: globalScene.getEnemyParty?.().length ?? null,
        leadMovePpUsed:
          globalScene
            .getPlayerParty?.()[0]
            ?.getMoveset()
            ?.map(move => move.ppUsed) ?? [],
      };
    },
    navigate: async (path: string): Promise<void> => {
      const { goto } = await import("$app/navigation");
      await goto(path);
    },
  };

  Object.defineProperty(window, "__pokerogueHost__", {
    configurable: true,
    writable: true,
    value: bridge,
  });
}
