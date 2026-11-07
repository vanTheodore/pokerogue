/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createPhaserGameConfig } from "#host/game-config";
import Phaser from "phaser";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for the Phaser game configuration extracted from `src/main.ts`.
 *
 * These lock down the settings that are easy to lose silently during an
 * architectural change (renderer, scale mode, plugins, input targets) without
 * requiring a browser or WebGL context.
 */
describe("Host - Phaser game config", () => {
  const scenes: Phaser.Types.Scenes.SceneType[] = [Phaser.Scene];
  const parent = { id: "app" } as HTMLElement;

  it("should reproduce the legacy renderer, scale and audio settings", () => {
    const config = createPhaserGameConfig({ parent, audioEnabled: true, scenes });

    expect(config.type).toBe(Phaser.WEBGL);
    expect(config.scale).toEqual({ width: 1920, height: 1080, mode: Phaser.Scale.FIT });
    expect(config.antialias).toBe(false);
    expect(config.audio).toEqual({ noAudio: false });
    expect(config.dom).toEqual({ createContainer: true });
    expect(config.scene).toBe(scenes);
  });

  it("should disable audio when the global audio setting is off", () => {
    const config = createPhaserGameConfig({ parent, audioEnabled: false, scenes });

    expect(config.audio).toEqual({ noAudio: true });
  });

  it("should keep the rex plugin registrations", () => {
    const config = createPhaserGameConfig({ parent, audioEnabled: true, scenes });

    const { global, scene } = config.plugins as Phaser.Types.Core.PluginObject;
    expect(global?.map(plugin => plugin.key)).toEqual([
      "rexInputTextPlugin",
      "rexBBCodeTextPlugin",
      "rexTransitionImagePackPlugin",
    ]);
    expect(scene?.map(plugin => plugin.mapping)).toEqual(["rexUI"]);
  });

  it("should mount into, and receive pointer input from, the given container", () => {
    const config = createPhaserGameConfig({ parent, audioEnabled: true, scenes });
    const input = config.input as Phaser.Types.Core.InputConfig;

    expect(config.parent).toBe(parent);
    expect((input.mouse as Phaser.Types.Core.MouseInputConfig).target).toBe(parent);
    expect((input.touch as Phaser.Types.Core.TouchInputConfig).target).toBe(parent);
    expect(input.gamepad).toBe(true);
  });

  it("should still accept a container id, for the legacy entry point", () => {
    const config = createPhaserGameConfig({ parent: "app", audioEnabled: true, scenes });
    const input = config.input as Phaser.Types.Core.InputConfig;

    expect(config.parent).toBe("app");
    expect((input.mouse as Phaser.Types.Core.MouseInputConfig).target).toBe("app");
  });

  it("should be free of side effects (no DOM writes on call)", () => {
    document.body.innerHTML = "";
    createPhaserGameConfig({ parent: "app", audioEnabled: true, scenes });

    expect(document.body.innerHTML).not.toContain("canvas");
  });
});
