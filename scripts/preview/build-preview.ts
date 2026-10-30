/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Build the static preview artifact (`build/`) and check what is in it.
 *
 * @remarks
 * The preview is a *production* build (`--mode production`) with a different set of environment
 * variables. The mode is not negotiable: `sharedConfig()` switches sourcemaps, tree-shaking and
 * minification on `mode`, so building a preview in a made-up mode would produce a different
 * bundle from the one that gets deployed, and the whole point of this artifact is to be the one
 * that gets deployed.
 *
 * Process environment wins over `.env` files in Vite, so the values below override
 * `.env.production` without editing it (and without introducing a `.env.preview` file whose
 * name would suggest its own mode):
 *
 * - `VITE_BYPASS_LOGIN=1` — guest mode: saves live in `localStorage`, no account, no server;
 * - `VITE_SERVER_URL` — deliberately unreachable. A preview must not touch the production API
 *   (that is a hard requirement of the migration, see `docs/MIGRATION-PLAN.md`), and guest mode
 *   is designed not to call it. The URL is only a backstop for a code path that would.
 * - `VITE_ENABLE_DEBUG_BRIDGE` — forwarded only when the caller asked for it, so the artifact
 *   built for a public preview has no observation bridge at all.
 *
 * Usage: `bun scripts/preview/build-preview.ts` (or `bun run build:preview`).
 */

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertArtifact, formatReport, inspectArtifact } from "./artifact.ts";
import { stageLocales } from "./stage-locales.ts";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const buildDir = resolve(projectRoot, "build");

/** Values that make a production build behave like an offline guest preview. */
const previewEnv = {
  // Guest mode: `localStorage` saves, no account, no session bootstrap against a server.
  VITE_BYPASS_LOGIN: "1",
  VITE_BYPASS_TUTORIAL: "0",
  // Unreachable on purpose: see the module documentation.
  VITE_SERVER_URL: "http://127.0.0.1:9",
  VITE_I18N_DEBUG: "0",
};

for (const submodule of ["assets", "locales"]) {
  if (!existsSync(resolve(projectRoot, submodule))) {
    console.error(
      `[preview] the \`${submodule}\` directory is missing: run \`bun run update-submodules\` `
        + "(the built site needs both, and a missing one only fails in the browser)",
    );
    process.exit(1);
  }
}

const debugBridge = process.env.VITE_ENABLE_DEBUG_BRIDGE === "1";

// A stale `build/` would make every check below pass while the served files are old ones.
rmSync(buildDir, { recursive: true, force: true });

const started = Date.now();
const build = spawnSync(
  process.execPath,
  [
    resolve(projectRoot, "node_modules", ".bin", "vite"),
    "build",
    "--config",
    "vite.config.app.ts",
    "--mode",
    "production",
  ],
  {
    cwd: projectRoot,
    env: { ...process.env, ...previewEnv, VITE_ENABLE_DEBUG_BRIDGE: debugBridge ? "1" : "0" },
    stdio: "inherit",
  },
);

if (build.status !== 0) {
  console.error(`[preview] the build failed with exit code ${build.status ?? "unknown"}`);
  process.exit(build.status ?? 1);
}

// `adapter-static` writes `build/` in its own `closeBundle`, after every plugin hook the app
// config can define, so the translations are staged here, once Vite has exited.
try {
  await stageLocales(projectRoot);
} catch (error) {
  console.error(`[preview] ${(error as Error).message}`);
  process.exit(1);
}

const report = inspectArtifact(buildDir, { debugBridge });
console.log(formatReport(report, buildDir));
console.log(`[preview] built in ${((Date.now() - started) / 1000).toFixed(1)}s`);

try {
  assertArtifact(report);
} catch (error) {
  console.error(`[preview] ${(error as Error).message}`);
  process.exit(1);
}

console.log("[preview] artifact OK — serve it with `bun run preview:static`");
