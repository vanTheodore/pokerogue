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

import { resolve } from "node:path";
import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, loadEnv, type Plugin, type UserConfig } from "vite";
import { sharedConfig } from "./vite.config.ts";

/**
 * Serve `#package.json` as a module instead of as a public file.
 *
 * @remarks
 * SvelteKit serves the public directory (`assets`, i.e. the asset submodule) at the URL root,
 * and that submodule ships its own `package.json`. The game imports `#package.json` for its
 * version (title screen, save data, migrations), which the browser requests as
 * `/package.json?import`; the static handler answered it with `application/json`, so the
 * browser refused to load it as a module ("Failed to fetch dynamically imported module") and
 * the game never booted — but only when the assets submodule was actually checked out, which
 * is why it was invisible in a bare checkout.
 *
 * Resolving the specifier to an absolute path here routes it through Vite's own module
 * pipeline instead. A `resolve.alias` entry cannot be used for this: it replaces the alias map
 * SvelteKit installs, which breaks `#app/*` and the rest of the tsconfig paths.
 */
function packageJsonModule(): Plugin {
  const file = resolve(process.cwd(), "package.json");

  return {
    name: "pokerogue:package-json-module",
    enforce: "pre",
    resolveId(id) {
      return id === "#package.json" ? file : null;
    },
    configureServer(server) {
      // Runs before SvelteKit's static-file middleware (same hook, earlier plugin): send the
      // request to Vite's module pipeline via `/@fs/`, which nothing shadows.
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith("/package.json?")) {
          req.url = `/@fs/${file.replace(/\\/g, "/")}?import`;
        }
        next();
      });
    },
  };
}

// biome-ignore lint/style/noDefaultExport: required for Vite
export default defineConfig(async config => {
  const { mode } = config;
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const envPort = Number(env.VITE_PORT);

  /**
   * Hostnames the dev server answers for.
   *
   * @remarks
   * Vite 8 rejects unknown `Host` headers by default (DNS-rebinding protection). The game has
   * no server-side routes, but the dev server is still an HTTP endpoint on the local machine,
   * so the allowlist stays closed by default and is extended *explicitly*:
   *
   * - `localhost` / `127.0.0.1` / `[::1]` always (normal local development).
   * - `VITE_DEV_ALLOWED_HOSTS="foo.example,bar.example"` for previews, LAN devices and tunnels.
   *   `.example` style entries (leading dot) also allow all subdomains.
   *
   * `allowedHosts: true` is deliberately NOT used: it disables the protection entirely.
   */
  const extraAllowedHosts = (env.VITE_DEV_ALLOWED_HOSTS ?? "")
    .split(",")
    .map(host => host.trim())
    .filter(Boolean);
  const allowedHosts = ["localhost", "127.0.0.1", "[::1]", ...extraAllowedHosts];

  const base = await sharedConfig(config, { legacyShell: false });

  return {
    ...base,
    // SvelteKit owns the HTML document, `base`, `publicDir`, the dev middleware and the
    // output directory; declaring them here would only trigger `vite_config_overridden`.
    appType: "custom",
    plugins: [
      ...(base.plugins ?? []),
      packageJsonModule(),
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
      // Restrictive by default; extend via `VITE_DEV_ALLOWED_HOSTS` (see above).
      allowedHosts,
    },
  } satisfies UserConfig;
});
