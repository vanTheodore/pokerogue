/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { type GameBootstrapper, GameHost, type GameHostSnapshot } from "#host/game-host";
import type Phaser from "phaser";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for the single-instance guarantee of the game host.
 *
 * The acceptance criteria for the SvelteKit migration require that the game never
 * ends up with two live `Phaser.Game` instances (double mounting, HMR, remounts).
 * The host is the component that enforces it, so it is tested here directly,
 * with an injected bootstrapper instead of a real WebGL boot.
 */

/** Minimal stand-in for a `Phaser.Game` instance. */
function createFakeGame() {
  return {
    destroy: vi.fn(),
  } as unknown as Phaser.Game & { destroy: ReturnType<typeof vi.fn> };
}

/** A bootstrapper that records calls and resolves with a fresh fake game. */
function createBootstrapper() {
  const games: ReturnType<typeof createFakeGame>[] = [];
  const bootstrapper: GameBootstrapper = vi.fn(async () => {
    const game = createFakeGame();
    games.push(game);
    return game;
  });
  return { bootstrapper, games };
}

describe("Host - GameHost lifecycle", () => {
  const options = { parent: {} as HTMLElement };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should start in the idle state", () => {
    const host = new GameHost(createBootstrapper().bootstrapper);

    expect(host.snapshot).toEqual<GameHostSnapshot>({
      status: "idle",
      error: null,
      instancesCreated: 0,
    });
    expect(host.game).toBeNull();
  });

  it("should create exactly one instance when started twice", async () => {
    const { bootstrapper, games } = createBootstrapper();
    const host = new GameHost(bootstrapper);

    const first = await host.start(options);
    const second = await host.start(options);

    expect(bootstrapper).toHaveBeenCalledTimes(1);
    expect(games).toHaveLength(1);
    expect(first).toBe(second);
    expect(host.snapshot.status).toBe("running");
  });

  it("should share a single boot between concurrent starts", async () => {
    const { bootstrapper, games } = createBootstrapper();
    const host = new GameHost(bootstrapper);

    const [a, b, c] = await Promise.all([host.start(options), host.start(options), host.start(options)]);

    expect(bootstrapper).toHaveBeenCalledTimes(1);
    expect(games).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("should report starting before the instance is available", async () => {
    let resolveBoot: (game: Phaser.Game) => void = () => {};
    const host = new GameHost(
      () =>
        new Promise<Phaser.Game>(resolve => {
          resolveBoot = resolve;
        }),
    );

    const started = host.start(options);
    expect(host.snapshot.status).toBe("starting");

    const game = createFakeGame();
    resolveBoot(game);
    await started;

    expect(host.snapshot.status).toBe("running");
    expect(host.game).toBe(game);
  });

  it("should destroy the instance and return to idle on dispose", async () => {
    const { bootstrapper, games } = createBootstrapper();
    const host = new GameHost(bootstrapper);
    await host.start(options);

    await host.dispose();

    expect(games[0].destroy).toHaveBeenCalledWith(true);
    expect(host.game).toBeNull();
    expect(host.snapshot).toEqual<GameHostSnapshot>({ status: "idle", error: null, instancesCreated: 1 });
  });

  it("should not leak an instance disposed during boot", async () => {
    let resolveBoot: (game: Phaser.Game) => void = () => {};
    const host = new GameHost(
      () =>
        new Promise<Phaser.Game>(resolve => {
          resolveBoot = resolve;
        }),
    );

    const started = host.start(options);
    const disposal = host.dispose();

    const game = createFakeGame();
    resolveBoot(game);
    await Promise.all([started, disposal]);

    expect(game.destroy).toHaveBeenCalledWith(true);
    expect(host.game).toBeNull();
    expect(host.snapshot.status).toBe("idle");
  });

  it("should allow a clean restart after dispose (remount / HMR)", async () => {
    const { bootstrapper, games } = createBootstrapper();
    const host = new GameHost(bootstrapper);

    await host.start(options);
    await host.dispose();
    await host.start(options);

    expect(games).toHaveLength(2);
    expect(games[1]).not.toBe(games[0]);
    expect(host.snapshot).toEqual<GameHostSnapshot>({ status: "running", error: null, instancesCreated: 2 });
  });

  it("should expose failures and allow a retry", async () => {
    const game = createFakeGame();
    const bootstrapper = vi
      .fn<GameBootstrapper>()
      .mockRejectedValueOnce(new Error("no WebGL"))
      .mockResolvedValueOnce(game);
    const host = new GameHost(bootstrapper);

    await expect(host.start(options)).rejects.toThrow("no WebGL");
    expect(host.snapshot).toEqual<GameHostSnapshot>({ status: "failed", error: "no WebGL", instancesCreated: 0 });

    await host.start(options);
    expect(host.snapshot).toEqual<GameHostSnapshot>({ status: "running", error: null, instancesCreated: 1 });
  });

  it("should notify subscribers on every state change and stop after unsubscribe", async () => {
    const { bootstrapper } = createBootstrapper();
    const host = new GameHost(bootstrapper);
    const statuses: string[] = [];

    const unsubscribe = host.subscribe(snapshot => statuses.push(snapshot.status));
    await host.start(options);
    await host.dispose();
    unsubscribe();

    await host.start(options);

    expect(statuses).toEqual(["idle", "starting", "running", "idle"]);
  });

  it("should be a singleton module export so all consumers share one host", async () => {
    const { gameHost } = await import("#host/game-host");
    const again = await import("#host/game-host");

    expect(again.gameHost).toBe(gameHost);
    // The shared host must not have been touched by the tests above.
    expect(gameHost.game).toBeNull();
    expect(gameHost.snapshot.status).toBe("idle");
  });
});
