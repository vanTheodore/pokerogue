/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SvelteKit scaffold guard.
 *
 * @remarks
 * Measured behaviour (SvelteKit 3.1 + Vite 8): tsconfig `#path` aliases
 * (`#app/*`, `#host/*`, `#constants/*`, ...) resolve inside `.ts` modules of both the
 * client *and* SSR environments, but **not** from `.svelte` files in the SSR environment.
 * A single `import { x } from "#app/..."` inside a route component therefore breaks
 * `vite build` with a "Rolldown failed to resolve import" error that has nothing to do
 * with the game code.
 *
 * Route components must use relative imports (or SvelteKit's own `$app`/`$lib`).
 * This test keeps that rule from being re-broken silently.
 */

const ROUTES_DIR = resolve(import.meta.dirname, "../../../src/routes");

function collectSvelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const fullPath = join(dir, entry);
    return statSync(fullPath).isDirectory()
      ? collectSvelteFiles(fullPath)
      : fullPath.endsWith(".svelte")
        ? [fullPath]
        : [];
  });
}

describe("Host - SvelteKit route modules", () => {
  it("should not import tsconfig path aliases from .svelte files", () => {
    const files = collectSvelteFiles(ROUTES_DIR);
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.flatMap(file => {
      const source = readFileSync(file, "utf-8");
      return [...source.matchAll(/from\s+"(#[\w/-]+)"/g)].map(match => `${file}: ${match[1]}`);
    });

    expect(offenders, "Use relative imports in .svelte route files (see docs/MIGRATION-PLAN.md §4)").toEqual([]);
  });

  it("should keep the game bootstrapping in the page component only", () => {
    const page = readFileSync(join(ROUTES_DIR, "+page.svelte"), "utf-8");

    // The lifecycle contract lives in `#host/game-host`: the component may not touch Phaser.
    expect(page).not.toMatch(/from\s+"phaser"/);
    // Lease bookkeeping lives in `PageGameLifecycle` (one code path for mount and retry, see
    // the regression test "should keep the instance alive when a failed boot is retried").
    // The component only starts and stops it.
    expect(page).toContain("new PageGameLifecycle(");
    expect(page).toContain("lifecycle.start()");
    expect(page).toContain("lifecycle?.stop()");
    // Acquiring/releasing leases by hand here is what produced the retry bug.
    expect(page).not.toContain("gameHost.acquire(");
    expect(page).not.toContain(".release()");
  });

  it("should keep the page lifecycle unit-testable", () => {
    const lifecycle = readFileSync(join(ROUTES_DIR, "..", "host", "page-lifecycle.ts"), "utf-8");

    // Same constraint as `game-host.ts`: this module is imported by the Vitest run.
    expect(lifecycle).not.toMatch(/\$app\//);
    expect(lifecycle).not.toMatch(/from\s+"phaser"/);
  });

  it("should not let the debug bridge leak into the host module", () => {
    const host = readFileSync(join(ROUTES_DIR, "..", "host", "game-host.ts"), "utf-8");

    // `game-host.ts` is imported by the Vitest suite, which does not run SvelteKit's Vite
    // plugin: a `$app/*` import there would break the unit tests (and cannot be resolved).
    expect(host).not.toMatch(/\$app\//);
    expect(host).not.toContain("__pokerogueHost__");
  });

  it("should disable SSR for the canvas application", () => {
    const layout = readFileSync(join(ROUTES_DIR, "+layout.ts"), "utf-8");

    expect(layout).toMatch(/export const ssr = false;/);
  });
});
