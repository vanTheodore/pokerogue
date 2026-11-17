/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Lifecycle hooks for module-level services that outlive a Phaser instance. */
export interface GameServiceLifecycle {
  /** Stop resources that need the live Phaser scene (for example active BGM) before game.destroy(). */
  readonly beforeGameDestroy?: () => void;
  /** Clear references so a later GameHost boot starts from clean module state. */
  readonly reset: () => void;
}

/**
 * Coordinates cleanup for game services held in module-level singletons.
 *
 * Services are reset in reverse registration order, matching stack unwinding. Hooks are run
 * independently so one faulty disposer cannot prevent the remaining references being cleared.
 */
export class ServiceRegistry {
  readonly #services = new Map<string, GameServiceLifecycle>();

  /** Register or replace one service lifecycle. */
  public register(name: string, lifecycle: GameServiceLifecycle): void {
    this.#services.set(name, lifecycle);
  }

  /** Run teardown hooks that require the Phaser scene to remain alive. */
  public beforeGameDestroy(): void {
    this.#run("beforeGameDestroy");
  }

  /** Clear all registered singleton state after the Phaser instance has been destroyed. */
  public reset(): void {
    this.#run("reset");
  }

  #run(phase: keyof GameServiceLifecycle): void {
    const errors: unknown[] = [];
    const services = [...this.#services.values()].reverse();

    for (const service of services) {
      const cleanup = service[phase];
      if (cleanup) {
        try {
          cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, `One or more game services failed during ${phase}`);
    }
  }
}

/** Registry used by the running game and its host. */
export const serviceRegistry = new ServiceRegistry();
