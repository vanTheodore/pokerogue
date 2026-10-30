/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Vite config for the SvelteKit host application.
 *
 * @remarks
 * This is a *second* Vite config on purpose:
 *
 * - `vite.config.ts` keeps serving the legacy MPA pipeline (`index.html` -> `src/main.ts`)
 *   and Vitest exactly as upstream defines it, so upstream changes to that file keep merging.
 * - This config boots SvelteKit (`src/app.html`, `src/routes`) while reusing the game's own
 *   build/tree-shaking settings through `sharedConfig`.
 *
 * Both pipelines share the same game sources, so a change in game code is visible to both.
 * The Vite *mode* is deliberately left at the standard values (`development`/`production`)
 * because `src/constants/app-constants.ts` derives `isDev`/`isBeta` from `import.meta.env.MODE`.
 *
 * Since SvelteKit 3, SvelteKit configuration lives in the `sveltekit()` plugin options
 * (`svelte.config.js` is no longer read), which is why the kit config below is inline.
 *
 * Usage:
 * - `bun run start:kit` -> SvelteKit dev server (development mode)
 * - `bun run build:kit` -> static SvelteKit build in `build/`
 */

import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, loadEnv, type UserConfig } from "vite";
import { sharedConfig } from "./vite.config.ts";

// biome-ignore lint/style/noDefaultExport: required for Vite
export default defineConfig(async config => {
  const { mode } = config;
  const envPort = Number(loadEnv(mode, process.cwd()).VITE_PORT);
  const base = await sharedConfig(config, { legacyShell: false });

  return {
    ...base,
    // SvelteKit owns the HTML document, `base`, `publicDir`, the dev middleware and the
    // output directory; declaring them here would only trigger `vite_config_overridden`.
    appType: "custom",
    plugins: [
      ...(base.plugins ?? []),
      sveltekit({
        // The game is a client-only, canvas-first application: there is no server-side work
        // to do yet, so a static SPA build reproduces today's hosting exactly.
        // Moving to `@sveltejs/adapter-bun` is evaluated when Phase D introduces a real backend.
        adapter: adapter({ fallback: "200.html", strict: false }),
        // `assets` is the existing asset submodule (shared with the legacy build),
        // not a new `static/` folder, so URLs stay identical between both pipelines.
        files: { assets: "assets" },
        prerender: { handleHttpError: "warn" },
      }),
    ],
    server: {
      port: Number.isNaN(envPort) ? 8000 : envPort,
      // SvelteKit restricts Vite's `fs.allow` to `kit.files.src`/routes/outDir, which excludes
      // root-level files. The shared stylesheet (`./index.css`) and fonts live there, so the
      // project root has to stay servable in dev.
      fs: { allow: [process.cwd()] },
      // Dev only: the host application is a canvas with no server routes, and dev servers
      // are frequently reached through a proxy/tunnel with a different `Host` header
      // (e.g. a remote preview). Production is served from the static build.
      allowedHosts: true,
    },
  } satisfies UserConfig;
});
