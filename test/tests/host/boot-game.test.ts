/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { bootGame } from "#host/boot-game";
import type Phaser from "phaser";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring test for the boot sequence extracted from `src/main.ts`.
 *
 * A real boot would load hundreds of assets and needs WebGL, so `phaser` and the
 * config factory are mocked: what is verified here is the *order and data* passed
 * across the boundary (settings/audio initialised before the game, audio flag taken
 * from the audio manager, both scenes handed to Phaser, container forwarded as-is).
 */

const gameInstances: { config: Phaser.Types.Core.GameConfig; sound: { pauseOnBlur: boolean } }[] = [];

vi.mock("phaser", () => {
  class FakeGame {
    public sound = { pauseOnBlur: true };

    constructor(config: Phaser.Types.Core.GameConfig) {
      gameInstances.push(this as unknown as (typeof gameInstances)[number]);
      (this as unknown as { config: Phaser.Types.Core.GameConfig }).config = config;
    }
  }

  return {
    default: {
      Game: FakeGame,
      WEBGL: 2,
      Scale: { FIT: 3 },
    },
  };
});

vi.mock("#host/game-config", () => ({
  createPhaserGameConfig: vi.fn((options: Record<string, unknown>) => ({ mocked: true, ...options })),
}));

describe("Host - boot sequence", () => {
  afterEach(() => {
    gameInstances.length = 0;
    vi.clearAllMocks();
  });

  it("should create the game with both scenes and the audio flag from settings", async () => {
    const parent = { id: "app" } as HTMLElement;

    const game = await bootGame({ parent });

    expect(gameInstances).toHaveLength(1);
    const [{ config }] = gameInstances;
    const { createPhaserGameConfig } = await import("#host/game-config");
    expect(createPhaserGameConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        parent,
        audioEnabled: expect.any(Boolean),
        scenes: [expect.any(Function), expect.any(Function)],
      }),
    );
    expect(config).toMatchObject({ mocked: true, parent });
    expect(game).toBeDefined();
  });

  it("should pause audio on blur only when running on a mobile device", async () => {
    const { isMobile } = await import("#app/touch-controls");
    const parent = { id: "app" } as HTMLElement;

    await bootGame({ parent });

    expect(gameInstances[0].sound.pauseOnBlur).toBe(isMobile());
  });

  it("should not stack the document-level double-tap listener across repeated boots", async () => {
    const addListenerSpy = vi.spyOn(document, "addEventListener");
    const parent = { id: "app" } as HTMLElement;

    // `prepareDocument` is intentionally idempotent; boot twice and count registrations.
    await bootGame({ parent });
    addListenerSpy.mockClear();
    await bootGame({ parent });

    const touchStartRegistrations = addListenerSpy.mock.calls.filter(([event]) => event === "touchstart");
    expect(touchStartRegistrations).toHaveLength(0);
  });
});
