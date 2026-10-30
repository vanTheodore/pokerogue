/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { version } from "#package.json";
import Phaser from "phaser";
import BBCodeTextPlugin from "phaser4-rex-plugins/plugins/bbcodetext-plugin";
import InputTextPlugin from "phaser4-rex-plugins/plugins/inputtext-plugin";
import TransitionImagePackPlugin from "phaser4-rex-plugins/templates/transitionimagepack/transitionimagepack-plugin";
import UIPlugin from "phaser4-rex-plugins/templates/ui/ui-plugin";

/**
 * Options needed to build the {@linkcode Phaser.Types.Core.GameConfig | Phaser game config}.
 *
 * @remarks
 * This is the *entire* contract required to construct a game instance.
 * Everything that is not listed here (scene loading, audio bootstrapping, i18n, ...)
 * is the caller's responsibility, which keeps this module free of side effects
 * and testable without a browser.
 */
export interface PhaserGameConfigOptions {
  /**
   * Element the canvas is appended to.
   *
   * Historically the string id `"app"`; the SvelteKit host passes the element itself
   * so ownership of the container is explicit instead of resolved through a global id.
   */
  parent: string | HTMLElement;
  /** Whether Phaser's sound manager is allowed to run (mirrors the global audio setting). */
  audioEnabled: boolean;
  /** The scene classes to boot, in order. */
  scenes: Phaser.Types.Scenes.SceneType[];
}

/**
 * Element the mouse/touch pointer targets.
 * Defaults to {@linkcode PhaserGameConfigOptions.parent}.
 */
function resolveInputTarget(parent: string | HTMLElement): string | HTMLElement {
  // Phaser accepts either a CSS selector/id or an element for both `parent` and input targets.
  return parent;
}

/**
 * Build the Phaser game configuration used by PokéRogue.
 *
 * @remarks
 * Mirrors the object previously inlined in `src/main.ts` (see `docs/MIGRATION-PLAN.md`).
 * Deliberately performs no DOM access and no scene loading so that both the legacy
 * MPA entry point and the SvelteKit host go through the same definition.
 *
 * @param options - The {@linkcode PhaserGameConfigOptions} to build from
 * @returns A fresh {@linkcode Phaser.Types.Core.GameConfig} object
 */
export function createPhaserGameConfig(options: PhaserGameConfigOptions): Phaser.Types.Core.GameConfig {
  const { parent, audioEnabled, scenes } = options;
  const inputTarget = resolveInputTarget(parent);

  return {
    type: Phaser.WEBGL,
    parent,
    audio: {
      noAudio: !audioEnabled,
    },
    scale: {
      width: 1920,
      height: 1080,
      mode: Phaser.Scale.FIT,
    },
    plugins: {
      global: [
        {
          key: "rexInputTextPlugin",
          plugin: InputTextPlugin,
          start: true,
        },
        {
          key: "rexBBCodeTextPlugin",
          plugin: BBCodeTextPlugin,
          start: true,
        },
        {
          key: "rexTransitionImagePackPlugin",
          plugin: TransitionImagePackPlugin,
          start: true,
        },
      ],
      scene: [
        {
          key: "rexUI",
          plugin: UIPlugin,
          mapping: "rexUI",
        },
      ],
    },
    input: {
      mouse: {
        target: inputTarget,
      },
      touch: {
        target: inputTarget,
      },
      gamepad: true,
    },
    dom: {
      createContainer: true,
    },
    antialias: false,
    scene: scenes,
    version,
  };
}
