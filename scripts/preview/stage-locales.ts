/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Copy the `locales` submodule into the static build.
 *
 * @remarks
 * The game fetches its translations at runtime (`./locales/<lang>/<namespace>.json`, see
 * `src/i18n.ts`); they are not bundled. In development the Vite server serves anything under
 * the project root, so `/locales/...` resolves by accident, and a dev-server test never sees
 * the difference. The *built* site only contains `kit.files.assets` (the `assets` submodule)
 * plus SvelteKit's own output — so every translation request would 404 and the game would run
 * with missing strings.
 *
 * The legacy MPA pipeline copies them in `plugins/vite/vite-minify-json-plugin.ts`, which
 * targets Vite's `dist/` and is disabled for the SvelteKit build. Doing it here, after Vite has
 * exited, is deliberate: a `closeBundle` hook in the app config runs *before* `adapter-static`
 * writes `build/`, so the adapter would immediately overwrite (that was the first attempt).
 *
 * `kit.files.assets` accepts a single directory in SvelteKit 3, so a second entry there is not
 * an option either.
 */

import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

/** Copy `<project>/locales` into `<project>/build/locales`, replacing any previous copy. */
export async function stageLocales(projectRoot: string): Promise<void> {
  const source = resolve(projectRoot, "locales");
  const destination = resolve(projectRoot, "build", "locales");

  if (!existsSync(source)) {
    throw new Error(`no \`locales\` directory at ${source}: run \`bun run update-submodules\` before building`);
  }

  // `cp` does not prune: a previous build may still hold translations from another revision.
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true });
}
