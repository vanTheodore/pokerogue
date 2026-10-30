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
 * - {@linkcode GameHost.start} is idempotent: concurrent and repeated calls share one boot.
 * - {@linkcode GameHost.dispose} destroys the instance and returns to `idle`,
 *   awaiting an in-flight boot so a unmount-during-boot cannot leak an instance.
 * - Every state change is observable through {@linkcode GameHost.subscribe}.
 */
export class GameHost {
  readonly #bootstrapper: GameBootstrapper;

  #status: GameHostStatus = "idle";
  #error: string | null = null;
  #game: Phaser.Game | null = null;
  #instancesCreated = 0;
  /** In-flight boot promise, if any. */
  #pending: Promise<Phaser.Game> | null = null;
  /** Set when {@linkcode GameHost.dispose} is called while a boot is in flight. */
  #disposeRequested = false;

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
   * Calling this while a boot is in flight joins that boot instead of starting a second one.
   * Calling it again after a failure retries.
   *
   * @param options - The {@linkcode GameHostOptions} to boot with
   * @returns The running instance
   * @throws Whatever the boot sequence throws, after the failure is recorded in the snapshot
   */
  public async start(options: GameHostOptions): Promise<Phaser.Game> {
    if (this.#status === "running" && this.#game) {
      return this.#game;
    }

    if (this.#pending) {
      return await this.#pending;
    }

    this.#disposeRequested = false;
    this.#setSnapshot("starting", null);

    const boot = this.#boot(options);
    this.#pending = boot;
    try {
      return await boot;
    } finally {
      if (this.#pending === boot) {
        this.#pending = null;
      }
    }
  }

  /**
   * Destroy the live instance, if any, and reset to `idle`.
   *
   * @remarks
   * Safe to call at any time, including while booting and after a failure.
   */
  public async dispose(): Promise<void> {
    this.#disposeRequested = true;

    if (this.#pending) {
      // Wait for the in-flight boot so we can destroy what it produced.
      await this.#pending.catch(() => undefined);
    }

    const game = this.#game;
    this.#game = null;
    this.#error = null;

    if (game) {
      game.destroy(true);
    }

    this.#disposeRequested = false;
    this.#setSnapshot("idle", null);
  }

  async #boot(options: GameHostOptions): Promise<Phaser.Game> {
    try {
      const game = await this.#bootstrapper(options);
      this.#instancesCreated++;

      if (this.#disposeRequested) {
        // The consumer unmounted while we were booting: honour the dispose now.
        game.destroy(true);
        this.#setSnapshot("idle", null);
        return game;
      }

      this.#game = game;
      this.#setSnapshot("running", null);
      return game;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#setSnapshot("failed", message);
      throw error;
    }
  }

  #setSnapshot(status: GameHostStatus, error: string | null): void {
    this.#status = status;
    this.#error = error;
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

/**
 * Read-only debug bridge used by the Playwright acceptance suite
 * (`e2e/app.spec.ts`) to assert lifecycle guarantees from the browser.
 *
 * @remarks
 * It is only installed in development builds, so production bundles do not expose
 * the live game instance. `snapshot()` reports how many instances were created,
 * which is what makes "no duplicate Phaser instance" testable from the outside.
 */
declare global {
  interface Window {
    __pokerogueHost__?: {
      snapshot: () => GameHostSnapshot;
      game: () => Phaser.Game | null;
    };
  }
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  Object.defineProperty(window, "__pokerogueHost__", {
    configurable: true,
    value: {
      snapshot: () => gameHost.snapshot,
      game: () => gameHost.game,
    },
  });
}
