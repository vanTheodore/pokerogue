/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import "#app/polyfills"; // All polyfills MUST be loaded first for side effects
import "#init/init-manifest"; // initializes the manifest, must be done *before* i18n is initialized due to being used for caching
import "#app/i18n"; // Initializes i18n on import

import { isMobile, preventDoubleTapZoom } from "#app/touch-controls";
import { isBeta, isDev } from "#constants/app-constants";
import Phaser from "phaser";
import { createPhaserGameConfig } from "./game-config";
import type { GameHostOptions } from "./game-host";

/**
 * Browser-only boot sequence for a PokéRogue game instance.
 *
 * @remarks
 * Extracted from `src/main.ts` so that the legacy MPA entry point and the SvelteKit
 * host run *the same* sequence: polyfills, manifest, i18n, settings, audio, then
 * the {@linkcode Phaser.Game} itself. The order is load order sensitive and must
 * not be rearranged casually:
 *
 * 1. `#app/polyfills` - must run before anything that assumes modern APIs
 * 2. `#init/init-manifest` - the manifest is consulted while loading locale files
 * 3. `#app/i18n` - registers fonts/languages on import
 * 4. settings + audio managers - the audio enable flag is part of the game config
 * 5. scenes - imported last so their module graphs are only evaluated once everything above exists
 *
 * This module must never be imported while rendering on a server: it evaluates
 * `document`/`window` at import time. Always reach it through a dynamic import
 * (see {@linkcode defaultBootstrapper} in `game-host.ts`).
 *
 * Phaser is imported *statically* here on purpose: it keeps the legacy pipeline's module
 * graph identical to the pre-extraction one (`main.ts` -> Phaser) instead of adding an
 * extra request waterfall on cold start (measured in docs/MIGRATION-PLAN.md §11.3).
 */

/** Document-level one-time setup, made idempotent so remounts/HMR do not stack listeners. */
let documentPrepared = false;

function prepareDocument(): void {
  if (documentPrepared) {
    return;
  }
  documentPrepared = true;

  if (isBeta || isDev) {
    document.title += " (Beta)";
  }

  // `preventDoubleTapZoom` registers a document-level listener; only ever register it once.
  preventDoubleTapZoom();
}

/**
 * Load the two bitmap fonts the game UI depends on.
 *
 * @remarks
 * Failures are logged but not fatal, matching the behaviour of the original entry point:
 * Phaser's text objects fall back to the next available font.
 */
async function loadGameFonts(): Promise<void> {
  try {
    await Promise.all([document.fonts.load("16px emerald"), document.fonts.load("10px pkmnems")]);
  } catch (err) {
    console.error("Error loading fonts:", err);
  }
}

/**
 * Boot a PokéRogue game instance inside the given container.
 *
 * @param options - The {@linkcode GameHostOptions} to boot with
 * @returns The created (already booting) {@linkcode Phaser.Game} instance
 */
export async function bootGame(options: GameHostOptions): Promise<Phaser.Game> {
  prepareDocument();
  await loadGameFonts();

  const { initSettingsManager } = await import("#app/global-settings-manager");
  const { initGlobalAudioManager } = await import("#app/global-audio-manager");

  await initSettingsManager();
  const audioManager = await initGlobalAudioManager();

  const { LoadingScene } = await import("#app/loading-scene");
  const { BattleScene } = await import("#app/battle-scene");

  const game = new Phaser.Game(
    createPhaserGameConfig({
      parent: options.parent,
      audioEnabled: audioManager.isAudioEnabled,
      scenes: [LoadingScene, BattleScene],
    }),
  );

  game.sound.pauseOnBlur = isMobile();

  return game;
}
