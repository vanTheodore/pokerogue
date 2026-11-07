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
 * The migration's acceptance criteria require that the game never ends up with two live
 * `Phaser.Game` instances (double mounting, HMR, remounts) and that it never hands a
 * consumer an instance that a concurrent teardown already destroyed.
 *
 * Every test here uses an injected bootstrapper plus a *manually resolvable* boot, so the
 * interleavings that produce the bugs (dispose during boot, remount during teardown, ...)
 * are deterministic instead of timing-dependent.
 */

/** Minimal stand-in for a `Phaser.Game` instance. */
function createFakeGame() {
  return {
    destroy: vi.fn(),
  } as unknown as Phaser.Game & { destroy: ReturnType<typeof vi.fn> };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A bootstrapper that resolves immediately with a fresh fake game. */
function createBootstrapper() {
  const games: ReturnType<typeof createFakeGame>[] = [];
  const bootstrapper: GameBootstrapper = vi.fn(async () => {
    const game = createFakeGame();
    games.push(game);
    return game;
  });
  return { bootstrapper, games };
}

/** A bootstrapper whose boots are resolved manually, one by one. */
function createManualBootstrapper() {
  const boots: Deferred<Phaser.Game>[] = [];
  const games: ReturnType<typeof createFakeGame>[] = [];
  const bootstrapper: GameBootstrapper = vi.fn(() => {
    const boot = deferred<Phaser.Game>();
    boots.push(boot);
    return boot.promise;
  });

  return {
    bootstrapper,
    games,
    /** Resolve the `index`-th pending boot, creating and returning its instance. */
    boots,
    finishBoot(index: number) {
      const game = createFakeGame();
      games[index] = game;
      boots[index].resolve(game);
      return game;
    },
  };
}

const OPTIONS = { parent: {} as HTMLElement };

describe("Host - GameHost lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should start in the idle state", () => {
    const host = new GameHost(createBootstrapper().bootstrapper);

    expect(host.snapshot).toEqual<GameHostSnapshot>({
      status: "idle",
      error: null,
      instancesCreated: 0,
      activeLeases: 0,
    });
    expect(host.game).toBeNull();
  });

  it("should create exactly one instance when started twice", async () => {
    const { bootstrapper, games } = createBootstrapper();
    const host = new GameHost(bootstrapper);

    const first = await host.start(OPTIONS);
    const second = await host.start(OPTIONS);

    expect(bootstrapper).toHaveBeenCalledTimes(1);
    expect(games).toHaveLength(1);
    expect(first).toBe(second);
    expect(host.snapshot.status).toBe("running");
  });

  it("should share a single boot between concurrent starts", async () => {
    const { bootstrapper, games } = createBootstrapper();
    const host = new GameHost(bootstrapper);

    const [a, b, c] = await Promise.all([host.start(OPTIONS), host.start(OPTIONS), host.start(OPTIONS)]);

    expect(bootstrapper).toHaveBeenCalledTimes(1);
    expect(games).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("should report starting before the instance is available", async () => {
    const { bootstrapper, finishBoot } = createManualBootstrapper();
    const host = new GameHost(bootstrapper);

    const started = host.start(OPTIONS);
    expect(host.snapshot.status).toBe("starting");

    const game = finishBoot(0);
    await started;

    expect(host.snapshot.status).toBe("running");
    expect(host.game).toBe(game);
  });

  it("should destroy the instance and return to idle on dispose", async () => {
    const { bootstrapper, games } = createBootstrapper();
    const host = new GameHost(bootstrapper);
    await host.start(OPTIONS);

    await host.dispose();

    expect(games[0].destroy).toHaveBeenCalledWith(true);
    expect(host.game).toBeNull();
    expect(host.snapshot).toEqual<GameHostSnapshot>({
      status: "idle",
      error: null,
      instancesCreated: 1,
      activeLeases: 0,
    });
  });

  it("should allow a clean restart after dispose (remount / HMR)", async () => {
    const { bootstrapper, games } = createBootstrapper();
    const host = new GameHost(bootstrapper);

    await host.start(OPTIONS);
    await host.dispose();
    await host.start(OPTIONS);

    expect(games).toHaveLength(2);
    expect(games[1]).not.toBe(games[0]);
    expect(host.snapshot.status).toBe("running");
    expect(host.snapshot.instancesCreated).toBe(2);
  });

  it("should expose failures and allow a retry", async () => {
    const game = createFakeGame();
    const bootstrapper = vi
      .fn<GameBootstrapper>()
      .mockRejectedValueOnce(new Error("no WebGL"))
      .mockResolvedValueOnce(game);
    const host = new GameHost(bootstrapper);

    await expect(host.start(OPTIONS)).rejects.toThrow("no WebGL");
    expect(host.snapshot).toEqual<GameHostSnapshot>({
      status: "failed",
      error: "no WebGL",
      instancesCreated: 0,
      activeLeases: 0,
    });

    await host.start(OPTIONS);
    expect(host.snapshot.status).toBe("running");
    expect(host.snapshot.instancesCreated).toBe(1);
  });

  it("should notify subscribers on every state change and stop after unsubscribe", async () => {
    const { bootstrapper } = createBootstrapper();
    const host = new GameHost(bootstrapper);
    const statuses: string[] = [];

    const unsubscribe = host.subscribe(snapshot => statuses.push(snapshot.status));
    await host.start(OPTIONS);
    await host.dispose();
    unsubscribe();

    await host.start(OPTIONS);

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

  // #region Races between start() and dispose()

  describe("dispose during boot", () => {
    /**
     * The bug this pins: the old implementation stored the boot promise and returned it
     * verbatim, so `start()` resolved with a `Phaser.Game` that `dispose()` had already
     * destroyed. Consumers then rendered into a dead canvas (and, worse, kept a reference
     * to an instance whose teardown had already run).
     */
    it("should reject instead of returning an instance destroyed by a concurrent dispose", async () => {
      const { bootstrapper, finishBoot } = createManualBootstrapper();
      const host = new GameHost(bootstrapper);

      const started = host.start(OPTIONS);
      const disposal = host.dispose();

      const game = finishBoot(0);
      await expect(started).rejects.toThrow(/disposed while booting/i);
      await disposal;

      expect(game.destroy).toHaveBeenCalledWith(true);
      expect(host.game).toBeNull();
      expect(host.snapshot.status).toBe("idle");
    });

    it("should not hand the destroyed instance to a caller that joined the boot", async () => {
      const { bootstrapper, finishBoot } = createManualBootstrapper();
      const host = new GameHost(bootstrapper);

      // Two consumers boot at the same time (double mount), then both lose the game.
      const first = host.start(OPTIONS);
      const second = host.start(OPTIONS);
      const disposal = host.dispose();

      const game = finishBoot(0);
      const results = await Promise.allSettled([first, second, disposal]);

      expect(results[0].status).toBe("rejected");
      expect(results[1].status).toBe("rejected");
      for (const result of results.slice(0, 2)) {
        expect((result as PromiseRejectedResult).reason).toHaveProperty("name", "GameHostDisposedError");
      }
      expect(game.destroy).toHaveBeenCalledOnce();
      expect(host.snapshot.status).toBe("idle");
    });

    it("should boot a fresh instance for a start() that arrives while disposing", async () => {
      const { bootstrapper, finishBoot, boots } = createManualBootstrapper();
      const host = new GameHost(bootstrapper);

      const first = host.start(OPTIONS);
      const disposal = host.dispose();
      // A new consumer mounts while the teardown is still running.
      const second = host.start(OPTIONS);

      finishBoot(0);
      await expect(first).rejects.toThrow();
      await disposal;

      // The second start waits for the teardown and then boots its own instance.
      // (Asserting on the boot rather than on a transient status keeps this deterministic:
      //  the loop resumes on a microtask after the teardown settles.)
      await vi.waitFor(() => expect(boots).toHaveLength(2));
      expect(host.snapshot.status).toBe("starting");
      finishBoot(1);
      const game = await second;

      expect(host.game).toBe(game);
      expect(host.snapshot.instancesCreated).toBe(2);
      expect(host.snapshot.status).toBe("running");
    });

    it("should boot a fresh instance after a disposed boot settles", async () => {
      const { bootstrapper, finishBoot } = createManualBootstrapper();
      const host = new GameHost(bootstrapper);

      const started = host.start(OPTIONS);
      const disposal = host.dispose();
      finishBoot(0);
      await expect(started).rejects.toThrow();
      await disposal;

      const restarted = host.start(OPTIONS);
      finishBoot(1);
      const game = await restarted;

      expect(host.game).toBe(game);
      expect(host.snapshot.instancesCreated).toBe(2);
    });

    it("should destroy exactly once when several disposals race with a boot", async () => {
      const { bootstrapper, finishBoot } = createManualBootstrapper();
      const host = new GameHost(bootstrapper);

      const started = host.start(OPTIONS);
      const disposals = [host.dispose(), host.dispose(), host.dispose()];

      const game = finishBoot(0);
      await expect(started).rejects.toThrow();
      await Promise.all(disposals);

      expect(game.destroy).toHaveBeenCalledOnce();
      expect(host.snapshot.status).toBe("idle");
    });

    it("should keep reporting a boot failure (not a disposal) when booting throws", async () => {
      const host = new GameHost(() => Promise.reject(new Error("WebGL unavailable")));

      const started = host.start(OPTIONS);
      await expect(started).rejects.toThrow("WebGL unavailable");

      expect(host.snapshot.status).toBe("failed");
      expect(host.snapshot.error).toBe("WebGL unavailable");
    });
  });

  describe("leases (remount / HMR ordering)", () => {
    it("should keep the instance alive until the last lease is released", async () => {
      const { bootstrapper, games } = createBootstrapper();
      const host = new GameHost(bootstrapper);

      const first = await host.acquire(OPTIONS);
      const second = await host.acquire(OPTIONS);
      expect(host.snapshot.activeLeases).toBe(2);
      expect(host.snapshot.instancesCreated).toBe(1);

      await first.release();
      expect(host.snapshot.status).toBe("running");
      expect(games[0].destroy).not.toHaveBeenCalled();

      await second.release();
      expect(games[0].destroy).toHaveBeenCalledOnce();
      expect(host.snapshot.status).toBe("idle");
    });

    /**
     * The remount ordering that a bare `onMount`/`onDestroy` pair gets wrong:
     * the new component mounts *before* the old one unmounts (HMR, client-side route
     * change). With reference counting the game survives; without it, the late unmount
     * destroys the instance the new component is already using.
     */
    it("should survive a mount-before-unmount remount", async () => {
      const { bootstrapper, games } = createBootstrapper();
      const host = new GameHost(bootstrapper);

      const previousComponent = await host.acquire(OPTIONS);
      const nextComponent = await host.acquire(OPTIONS); // mounts first
      await previousComponent.release(); // then the old one unmounts

      expect(games[0].destroy).not.toHaveBeenCalled();
      expect(host.snapshot.status).toBe("running");
      expect(nextComponent.game).toBe(previousComponent.game);

      await nextComponent.release();
      expect(games[0].destroy).toHaveBeenCalledOnce();
    });

    it("should ignore duplicate releases", async () => {
      const { bootstrapper, games } = createBootstrapper();
      const host = new GameHost(bootstrapper);

      const lease = await host.acquire(OPTIONS);
      await lease.release();
      await lease.release();

      expect(host.snapshot.activeLeases).toBe(0);
      expect(games[0].destroy).toHaveBeenCalledOnce();
    });

    it("should release its lease when the boot is disposed mid-flight", async () => {
      const { bootstrapper, finishBoot } = createManualBootstrapper();
      const host = new GameHost(bootstrapper);

      const acquired = host.acquire(OPTIONS);
      expect(host.snapshot.activeLeases).toBe(1);

      const disposal = host.dispose();
      finishBoot(0);

      await expect(acquired).rejects.toThrow(/disposed while booting/i);
      await disposal;

      expect(host.snapshot.activeLeases).toBe(0);
      expect(host.snapshot.status).toBe("idle");
    });

    it("should let a later lease boot again after everything was released", async () => {
      const { bootstrapper, games } = createBootstrapper();
      const host = new GameHost(bootstrapper);

      const first = await host.acquire(OPTIONS);
      await first.release();
      const lease = await host.acquire(OPTIONS);

      expect(games).toHaveLength(2);
      expect(lease.game).toBe(games[1]);
    });
  });

  // #endregion
});
