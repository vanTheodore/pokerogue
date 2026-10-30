/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type Phaser from "phaser";

/**
 * Lifecycle states of the game host.
 *
 * - `idle` - no instance exists (initial state, or after {@linkcode GameHost.dispose})
 * - `starting` - the boot sequence is running, no instance is available yet
 * - `running` - exactly one live {@linkcode Phaser.Game} instance exists
 * - `failed` - booting threw; {@linkcode GameHostSnapshot.error} holds the message
 */
export type GameHostStatus = "idle" | "starting" | "running" | "failed";

/** Immutable view of the host state, used by UI consumers. */
export interface GameHostSnapshot {
  readonly status: GameHostStatus;
  /** Human readable failure reason, `null` unless {@linkcode GameHostStatus} is `"failed"`. */
  readonly error: string | null;
  /** How many {@linkcode Phaser.Game} instances have been created by this host. */
  readonly instancesCreated: number;
  /** How many consumers currently hold a lease (see {@linkcode GameHost.acquire}). */
  readonly activeLeases: number;
}

/** Everything the host needs to boot a game instance. */
export interface GameHostOptions {
  /** Element (or element id) the canvas is appended to. */
  parent: string | HTMLElement;
}

/**
 * Creates a running game instance.
 *
 * Kept as an injectable dependency so the lifecycle guarantees can be tested
 * without bootstrapping i18n, audio, assets and WebGL.
 */
export type GameBootstrapper = (options: GameHostOptions) => Promise<Phaser.Game>;

/** Listener invoked on every state change. */
export type GameHostListener = (snapshot: GameHostSnapshot) => void;

/**
 * Thrown by {@linkcode GameHost.start} when the instance it was booting was invalidated
 * by a concurrent {@linkcode GameHost.dispose}.
 *
 * @remarks
 * This is a *normal* outcome of unmounting while the game is still booting: callers
 * should swallow it (and *not* treat it as a failed boot). It exists so a disposed
 * instance can never be handed to a consumer as if it were usable.
 */
export class GameHostDisposedError extends Error {
  constructor(message = "The game host was disposed while booting") {
    super(message);
    this.name = "GameHostDisposedError";
  }
}

/** A consumer's claim on the running instance. */
export interface GameLease {
  /** The running instance. */
  readonly game: Phaser.Game;
  /**
   * Drop this claim. The instance is destroyed once the last lease is released.
   *
   * @returns A promise that resolves when the release has been processed
   */
  release(): Promise<void>;
}

/**
 * Default bootstrapper: loads the browser-only boot sequence lazily.
 *
 * @remarks
 * The dynamic import is what keeps this module safe to reference from
 * SvelteKit code that may be analysed (or executed) on the server: nothing
 * touches `document`, `window`, WebGL or Phaser until {@linkcode GameHost.start} runs.
 */
export const defaultBootstrapper: GameBootstrapper = async options => {
  const { bootGame } = await import("./boot-game");
  return await bootGame(options);
};

/**
 * Owns the single {@linkcode Phaser.Game} instance of the application.
 *
 * @remarks
 * Phaser keeps global state (plugin cache, global scene reference, audio contexts),
 * so more than one live instance is never valid. This class centralises that
 * invariant instead of relying on every entry point to remember it:
 *
 * - **Single instance**: concurrent `start()` calls share one boot.
 * - **No zombie hand-off**: if the boot is invalidated by a concurrent `dispose()`,
 *   the instance is destroyed and `start()` rejects with {@linkcode GameHostDisposedError}
 *   instead of returning an instance that is already dead (the caller unmounted).
 * - **Order-independent remounts**: {@linkcode GameHost.acquire} returns a lease and only
 *   destroys the game once the *last* lease is released, so a component that mounts
 *   before the previous one unmounts (HMR, router transition) cannot have its game
 *   destroyed underneath it.
 * - **Idempotent teardown**: repeated `dispose()` calls share one teardown and destroy once.
 * - Every state change is observable through {@linkcode GameHost.subscribe}.
 */
export class GameHost {
  readonly #bootstrapper: GameBootstrapper;

  #status: GameHostStatus = "idle";
  #error: string | null = null;
  #game: Phaser.Game | null = null;
  #instancesCreated = 0;
  #leases = 0;

  /** In-flight boot, if any. Shared by every caller that joins it. */
  #boot: { promise: Promise<Phaser.Game> } | null = null;
  /** In-flight teardown, if any. Shared by every caller that joins it. */
  #stopping: Promise<void> | null = null;

  /**
   * Incremented on every `dispose()`. A boot captures the generation it started in,
   * and refuses to publish its instance if the generation moved on meanwhile.
   */
  #generation = 0;

  readonly #listeners = new Set<GameHostListener>();

  constructor(bootstrapper: GameBootstrapper = defaultBootstrapper) {
    this.#bootstrapper = bootstrapper;
  }

  /** Current {@linkcode GameHostSnapshot}. */
  public get snapshot(): GameHostSnapshot {
    return {
      status: this.#status,
      error: this.#error,
      instancesCreated: this.#instancesCreated,
      activeLeases: this.#leases,
    };
  }

  /** The live instance, or `null` when nothing is running. */
  public get game(): Phaser.Game | null {
    return this.#game;
  }

  /**
   * Subscribe to state changes.
   *
   * @param listener - Called immediately with the current snapshot, then on every change
   * @returns An unsubscribe function
   */
  public subscribe(listener: GameHostListener): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Start the game if it is not already running.
   *
   * @remarks
   * - While a boot is in flight, every caller joins it (no second instance is ever created).
   * - While a teardown is in flight, the caller waits for it and then re-evaluates.
   * - If the boot is invalidated by a `dispose()` (e.g. the component unmounted mid-boot),
   *   this rejects with {@linkcode GameHostDisposedError} and the instance is destroyed.
   *
   * @param options - The {@linkcode GameHostOptions} to boot with
   * @returns The running instance
   * @throws {@linkcode GameHostDisposedError} if a concurrent dispose invalidated this boot
   */
  public async start(options: GameHostOptions): Promise<Phaser.Game> {
    for (;;) {
      // A teardown is checked *before* the in-flight boot: while a teardown runs, the boot it
      // is unwinding is doomed (it will reject with `GameHostDisposedError`), so a caller that
      // arrives now must wait for the teardown and start its own instance instead of joining it.
      const stopping = this.#stopping;
      if (stopping) {
        await stopping.catch(() => undefined);
        continue;
      }

      const inFlight = this.#boot;
      if (inFlight) {
        // Join the existing boot. Errors (including "disposed during boot") propagate so
        // that no caller can be handed an instance that is already destroyed.
        return await inFlight.promise;
      }

      if (this.#status === "running" && this.#game) {
        return this.#game;
      }

      return await this.#beginBoot(options);
    }
  }

  /**
   * Take a lease on the running instance, booting it if necessary.
   *
   * @remarks
   * Prefer this over {@linkcode GameHost.start} from UI components: leases make
   * mount/unmount order irrelevant. If a new component acquires a lease *before* the
   * previous one releases its own, the game keeps running instead of being torn down
   * and rebuilt.
   *
   * @param options - The {@linkcode GameHostOptions} to boot with, if booting is needed
   * @returns A {@linkcode GameLease} that must be released
   */
  public async acquire(options: GameHostOptions): Promise<GameLease> {
    this.#leases++;
    this.#notify(); // observers see the new lease count

    try {
      const game = await this.start(options);
      let released = false;

      return {
        game,
        release: async () => {
          if (released) {
            return;
          }
          released = true;
          this.#leases = Math.max(0, this.#leases - 1);

          if (this.#leases === 0) {
            await this.dispose();
          } else {
            this.#notify();
          }
        },
      };
    } catch (error) {
      this.#leases = Math.max(0, this.#leases - 1);
      throw error;
    }
  }

  /**
   * Destroy the live instance and reset to `idle`.
   *
   * @remarks
   * Safe to call at any time (running, booting, failed, or already idle). Concurrent calls
   * share one teardown, so the instance is destroyed exactly once.
   */
  public async dispose(): Promise<void> {
    const existing = this.#stopping;
    if (existing) {
      return await existing;
    }

    const teardown = this.#teardown();
    this.#stopping = teardown;
    try {
      await teardown;
    } finally {
      if (this.#stopping === teardown) {
        this.#stopping = null;
      }
    }
  }

  async #teardown(): Promise<void> {
    // Invalidate any in-flight boot *before* awaiting it, so its result is never published.
    this.#generation++;
    const inFlight = this.#boot;

    if (inFlight) {
      // The boot will destroy its own instance and reject; that rejection is expected here.
      await inFlight.promise.catch(() => undefined);
    }

    const game = this.#game;
    this.#game = null;
    this.#error = null;

    game?.destroy(true);

    this.#setSnapshot("idle", null);
  }

  async #beginBoot(options: GameHostOptions): Promise<Phaser.Game> {
    this.#setSnapshot("starting", null);

    const generation = this.#generation;
    const promise = this.#runBoot(options, generation);
    const record: { promise: Promise<Phaser.Game> } = { promise };
    this.#boot = record;

    // Clear the record once settled, without creating an unhandled rejection.
    promise
      .finally(() => {
        if (this.#boot === record) {
          this.#boot = null;
        }
      })
      .catch(() => undefined);

    return await promise;
  }

  async #runBoot(options: GameHostOptions, generation: number): Promise<Phaser.Game> {
    let game: Phaser.Game;
    try {
      game = await this.#bootstrapper(options);
    } catch (error) {
      this.#setSnapshot("failed", error instanceof Error ? error.message : String(error));
      throw error;
    }

    this.#instancesCreated++;

    if (generation !== this.#generation) {
      // A dispose() happened while we were booting: the caller is gone, so never publish
      // (nor hand back) an instance nobody owns.
      game.destroy(true);
      this.#setSnapshot("idle", null);
      throw new GameHostDisposedError();
    }

    this.#game = game;
    this.#setSnapshot("running", null);
    return game;
  }

  #setSnapshot(status: GameHostStatus, error: string | null): void {
    this.#status = status;
    this.#error = error;
    this.#notify();
  }

  /** Push the current snapshot to every listener. */
  #notify(): void {
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }
}

/**
 * The application-wide game host.
 *
 * @remarks
 * A module-level singleton (like the existing `globalScene`/`settings` managers)
 * so that HMR, remounts and any future route that needs the instance all address
 * the same owner. `import.meta.hot` disposal releases the instance on HMR.
 */
export const gameHost = new GameHost();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void gameHost.dispose();
  });
}
