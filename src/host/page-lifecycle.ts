/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { type GameHost, GameHostDisposedError, type GameLease } from "./game-host";

/** What {@linkcode PageGameLifecycle} needs from its surroundings. */
export interface PageGameLifecycleOptions {
  /** The host that owns the single game instance. */
  readonly host: GameHost;
  /** Resolves the element the canvas is attached to, at call time (it may not exist yet). */
  readonly resolveParent: () => HTMLElement | null;
  /** Called with anything that is not a normal "the page went away" cancellation. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Owns the page component's claim (lease) on the game.
 *
 * @remarks
 * Extracted from `src/routes/+page.svelte` because the interesting behaviour — *who keeps the
 * game alive* — is not view logic, and because having two code paths for "start" and "retry"
 * is exactly how a page ends up destroying the game it just restarted:
 *
 * - {@linkcode PageGameLifecycle.start} is idempotent and is the *only* path that acquires a
 *   lease, so the first mount and the "Try again" button go through the same code. The retry
 *   keeps the lease it acquired (releasing it straight away would destroy the instance the
 *   user just asked for, since a failed first boot holds no other lease).
 * - {@linkcode PageGameLifecycle.stop} releases it, and is safe at any time: during a boot the
 *   lease is handed back as soon as it is acquired, so nothing is leaked.
 *
 * Everything it does is expressible against {@linkcode GameHost}, so it is unit tested with a
 * real host and an injected bootstrapper (no DOM, no Phaser).
 */
export class PageGameLifecycle {
  readonly #host: GameHost;
  readonly #resolveParent: () => HTMLElement | null;
  readonly #onError: (error: unknown) => void;

  /** The lease this page holds, if the game is running because of us. */
  #lease: GameLease | null = null;
  /** In-flight `start()`, shared so a double click cannot boot twice. */
  #pending: Promise<void> | null = null;
  /** Set by `stop()`; a boot that finishes afterwards must hand its lease back. */
  #stopped = false;

  constructor({ host, resolveParent, onError }: PageGameLifecycleOptions) {
    this.#host = host;
    this.#resolveParent = resolveParent;
    this.#onError = onError ?? (error => console.error("[host] Game lifecycle error:", error));
  }

  /**
   * True while this page component is the reason the game is running.
   *
   * @remarks
   * Exposed for tests and for the UI to know whether it may offer "Try again"; it is not used
   * to decide whether to destroy anything.
   */
  public get isRunning(): boolean {
    return this.#lease !== null;
  }

  /**
   * Start the game, or retry it after a failed boot.
   *
   * @remarks
   * The same call for both cases, on purpose (see the class remarks). Calling it while the game
   * is already running — or while a boot is in flight — is a no-op that joins the current one.
   *
   * Failures are reported through `onError` instead of rejecting: the component renders the
   * failure from the host snapshot, and an unhandled rejection from an event handler would only
   * add noise. A boot cancelled by `stop()` is not reported at all.
   */
  public async start(): Promise<void> {
    if (this.#stopped || this.#lease) {
      return;
    }

    if (this.#pending) {
      return await this.#pending;
    }

    const pending = this.#acquire();
    this.#pending = pending;
    try {
      await pending;
    } finally {
      if (this.#pending === pending) {
        this.#pending = null;
      }
    }
  }

  /** Release the claim on the game; it is destroyed when no other page holds one. */
  public async stop(): Promise<void> {
    this.#stopped = true;

    // A boot in flight will hand its lease back by itself (see `#acquire`).
    await this.#pending?.catch(() => undefined);

    const lease = this.#lease;
    this.#lease = null;
    await lease?.release();
  }

  async #acquire(): Promise<void> {
    const parent = this.#resolveParent();
    if (!parent) {
      this.#onError(new Error("The game container is missing from the page template; cannot mount the game."));
      return;
    }

    let lease: GameLease;
    try {
      lease = await this.#host.acquire({ parent });
    } catch (error) {
      // A boot cancelled because the page went away is a normal outcome, not a failure.
      if (!(error instanceof GameHostDisposedError)) {
        this.#onError(error);
      }
      return;
    }

    if (this.#stopped) {
      // The page was destroyed while booting: give the claim back so the instance is not leaked.
      await lease.release();
      return;
    }

    this.#lease = lease;
  }
}
