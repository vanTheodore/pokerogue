/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { GameHost } from "#host/game-host";
import { PageGameLifecycle } from "#host/page-lifecycle";
import type Phaser from "phaser";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for the page's claim on the game (the "Try again" path).
 *
 * @remarks
 * These use a **real** `GameHost` with an injected bootstrapper, so the lease/generation
 * bookkeeping under test is the production one, not a mock of it. The DOM is the only thing
 * replaced (the parent element is an empty object).
 */

function createFakeGame() {
  return { destroy: vi.fn() } as unknown as Phaser.Game & { destroy: ReturnType<typeof vi.fn> };
}

const PARENT = {} as HTMLElement;

describe("Host - PageGameLifecycle", () => {
  let games: ReturnType<typeof createFakeGame>[];

  beforeEach(() => {
    games = [];
  });

  /** A host whose first `failures` boots reject, then boots normally. */
  function createHost(failures = 0) {
    let calls = 0;
    const host = new GameHost(async () => {
      calls++;
      if (calls <= failures) {
        throw new Error("WebGL unavailable");
      }
      const game = createFakeGame();
      games.push(game);
      return game;
    });
    return host;
  }

  function createLifecycle(host: GameHost, onError = vi.fn()) {
    const lifecycle = new PageGameLifecycle({ host, resolveParent: () => PARENT, onError });
    return { lifecycle, onError };
  }

  it("should hold the lease while the game runs", async () => {
    const host = createHost();
    const { lifecycle } = createLifecycle(host);

    await lifecycle.start();

    expect(lifecycle.isRunning).toBe(true);
    expect(host.snapshot.status).toBe("running");
    expect(host.snapshot.activeLeases).toBe(1);
    expect(host.game).toBe(games[0]);
  });

  /**
   * The bug this pins: the retry used to acquire a lease and release it immediately, on the
   * assumption that the mount effect held another one. After a *failed* boot it does not — the
   * mount effect never got a lease — so releasing the retry's lease left the host with zero
   * consumers, and `GameHost` correctly destroyed the instance the user had just restarted.
   * The page showed a game that had already been torn down (a dead canvas, `status: "idle"`).
   */
  it("should keep the instance alive when a failed boot is retried", async () => {
    const host = createHost(1);
    const { lifecycle, onError } = createLifecycle(host);

    // First mount: the boot fails.
    await lifecycle.start();
    expect(onError).toHaveBeenCalledOnce();
    expect(host.snapshot.status).toBe("failed");
    expect(lifecycle.isRunning).toBe(false);
    expect(host.snapshot.activeLeases).toBe(0);

    // "Try again": same call, now it succeeds.
    await lifecycle.start();

    expect(host.snapshot.status).toBe("running");
    expect(lifecycle.isRunning).toBe(true);
    expect(host.snapshot.activeLeases).toBe(1);
    expect(games).toHaveLength(1);
    expect(host.game).toBe(games[0]);
    // The retried instance must NOT have been destroyed by the retry itself.
    expect(games[0].destroy).not.toHaveBeenCalled();

    // ...and it is still alive an event-loop turn later (nothing else releases it).
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(games[0].destroy).not.toHaveBeenCalled();
    expect(host.snapshot.status).toBe("running");
  });

  it("should keep the instance alive across repeated retries", async () => {
    const host = createHost(2);
    const { lifecycle } = createLifecycle(host);

    await lifecycle.start(); // fails
    await lifecycle.start(); // fails
    await lifecycle.start(); // succeeds
    await lifecycle.start(); // no-op: already running

    expect(games).toHaveLength(1);
    expect(host.snapshot.instancesCreated).toBe(1);
    expect(host.snapshot.activeLeases).toBe(1);
    expect(games[0].destroy).not.toHaveBeenCalled();
  });

  it("should destroy the instance only when the page stops", async () => {
    const host = createHost(1);
    const { lifecycle } = createLifecycle(host);

    await lifecycle.start();
    await lifecycle.start(); // retry -> running
    await lifecycle.stop();

    expect(games[0].destroy).toHaveBeenCalledOnce();
    expect(host.snapshot.status).toBe("idle");
    expect(host.snapshot.activeLeases).toBe(0);
  });

  it("should not start a second instance when started twice concurrently", async () => {
    const host = createHost();
    const { lifecycle } = createLifecycle(host);

    await Promise.all([lifecycle.start(), lifecycle.start(), lifecycle.start()]);

    expect(games).toHaveLength(1);
    expect(host.snapshot.activeLeases).toBe(1);
  });

  it("should hand the lease back when stopped during a boot", async () => {
    let finishBoot: (game: Phaser.Game) => void = () => {};
    const boot = new Promise<Phaser.Game>(resolve => {
      finishBoot = resolve;
    });
    const host = new GameHost(() => boot);
    const { lifecycle } = createLifecycle(host);

    const started = lifecycle.start();
    expect(host.snapshot.activeLeases).toBe(1);

    const stopped = lifecycle.stop();
    const game = createFakeGame();
    finishBoot(game);
    await Promise.all([started, stopped]);

    // The instance created for a page that no longer exists must not be left running.
    expect(game.destroy).toHaveBeenCalledOnce();
    expect(host.snapshot.activeLeases).toBe(0);
    expect(host.snapshot.status).toBe("idle");
    expect(lifecycle.isRunning).toBe(false);
  });

  it("should stay stopped when a retry is requested after the page is gone", async () => {
    const host = createHost(1);
    const { lifecycle } = createLifecycle(host);

    await lifecycle.start(); // fails
    await lifecycle.stop();
    await lifecycle.start(); // the user clicks the button while unmounting

    expect(host.snapshot.status).toBe("failed");
    expect(games).toHaveLength(0);
  });

  it("should report a missing container instead of throwing", async () => {
    const host = createHost();
    const onError = vi.fn();
    const lifecycle = new PageGameLifecycle({ host, resolveParent: () => null, onError });

    await lifecycle.start();

    expect(onError).toHaveBeenCalledOnce();
    expect(host.snapshot.status).toBe("idle");
  });

  it("should not report a boot cancelled by unmounting as an error", async () => {
    let finishBoot: (game: Phaser.Game) => void = () => {};
    const host = new GameHost(
      () =>
        new Promise<Phaser.Game>(resolve => {
          finishBoot = resolve;
        }),
    );
    const onError = vi.fn();
    const lifecycle = new PageGameLifecycle({ host, resolveParent: () => PARENT, onError });

    const started = lifecycle.start();
    const stopped = lifecycle.stop();
    finishBoot(createFakeGame());
    await Promise.all([started, stopped]);

    expect(onError).not.toHaveBeenCalled();
  });
});
