/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Inspection of a built preview artifact (`build/`).
 *
 * @remarks
 * `bun run build:preview` and the `Bun CI` workflow both call this: a build that *completes*
 * is not a build that *works*, and the failure modes that matter here are silent ones — a
 * missing `locales/` directory only shows up as untranslated UI in a browser, and a build that
 * still points at the production API fails `frozen-lockfile`-style checks nowhere, because
 * nothing looks at it.
 *
 * The checks are deliberately about the artifact's *contents*, not about running it: running
 * it is what the Playwright build project does (`playwright.build.config.ts`).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

/** The production API host. A preview must never reference it (see `docs/PREVIEW.md`). */
export const PRODUCTION_API_HOST = "api.pokerogue.net";

/** Marker exposed by `src/host/debug-bridge.ts`. */
export const DEBUG_BRIDGE_MARKER = "__pokerogueHost__";

/** Expected shape of the artifact, and why each entry exists. */
export interface ArtifactExpectations {
  /** Whether this build was made with `VITE_ENABLE_DEBUG_BRIDGE=1`. */
  readonly debugBridge: boolean;
}

/** One thing that is wrong with the artifact. */
export interface ArtifactProblem {
  /** Short identifier, stable enough to assert on in tests. */
  readonly code: string;
  /** Human-readable explanation that says what to do about it. */
  readonly message: string;
}

/** Measurements taken from the artifact. */
export interface ArtifactReport {
  readonly fileCount: number;
  readonly totalBytes: number;
  /** Largest files, for deployments with per-file limits. */
  readonly largestFiles: readonly { path: string; bytes: number }[];
  /** Number of files under `images/`, `fonts/` and `battle-anims/`. */
  readonly assetFileCount: number;
  readonly problems: readonly ArtifactProblem[];
}

/** Recursively collect `path -> size` for every file under `dir`. */
function walk(dir: string, prefix = ""): { path: string; bytes: number }[] {
  const entries: { path: string; bytes: number }[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      entries.push(...walk(absolute, relativePath));
    } else if (entry.isFile()) {
      entries.push({ path: relativePath, bytes: statSync(absolute).size });
    }
  }

  return entries;
}

/** Read a text file, or return `null` when it does not exist. */
function readTextFile(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Inspect a built artifact and report what it contains and what it is missing. */
export function inspectArtifact(root: string, expectations: ArtifactExpectations): ArtifactReport {
  const problems: ArtifactProblem[] = [];
  const files = walk(root);
  const paths = new Set(files.map(file => file.path));

  const require = (path: string, code: string, message: string): void => {
    if (!paths.has(path)) {
      problems.push({ code, message });
    }
  };

  // The two documents SvelteKit generates: the prerendered index and the SPA fallback.
  require("index.html", "missing-index", "build/index.html is missing: nothing to serve at `/`");
  require("200.html", "missing-fallback", "build/200.html is missing: client-side routes cannot be served");

  // Translations are fetched at runtime (`./locales/<lang>/<namespace>.json`), so they have to
  // be in the artifact even though nothing imports them.
  require("locales/en/menu.json", "missing-locales", "build/locales/ is missing: the UI would have no text");

  // The game cannot start without the sprite atlases and the two fonts.
  require("images/pokemon/1.png", "missing-assets", "build/images/ is missing: the game cannot render");
  require("fonts/pkmnems.ttf", "missing-fonts", "build/fonts/ is missing: the UI would use a fallback font");

  if (![...paths].some(path => path.startsWith("_app/immutable/entry/"))) {
    problems.push({
      code: "missing-app-chunks",
      message: "build/_app/immutable/entry/ is missing: the SvelteKit bundle was not written",
    });
  }

  // Content scans. Only scripts and documents can carry a hostname or a marker meaningfully;
  // scanning ~30 000 sprite files would only make the check slow.
  const textFiles = files.filter(file => {
    const extension = extname(file.path);
    return extension === ".js" || extension === ".html";
  });

  const apiReferences: string[] = [];
  const bridgeFiles: string[] = [];

  for (const file of textFiles) {
    const contents = readTextFile(join(root, file.path));
    if (contents === null) {
      continue;
    }
    if (contents.includes(PRODUCTION_API_HOST)) {
      apiReferences.push(file.path);
    }
    if (contents.includes(DEBUG_BRIDGE_MARKER)) {
      bridgeFiles.push(file.path);
    }
  }

  if (apiReferences.length > 0) {
    problems.push({
      code: "production-api-reference",
      message:
        `the build references ${PRODUCTION_API_HOST} in ${apiReferences.slice(0, 3).join(", ")}: `
        + "a preview must run in guest mode against no backend (see docs/PREVIEW.md)",
    });
  }

  if (expectations.debugBridge && bridgeFiles.length === 0) {
    problems.push({
      code: "missing-debug-bridge",
      message: `the build has no ${DEBUG_BRIDGE_MARKER}: it was expected because VITE_ENABLE_DEBUG_BRIDGE=1`,
    });
  }

  if (!expectations.debugBridge && bridgeFiles.length > 0) {
    problems.push({
      code: "unexpected-debug-bridge",
      message:
        `the build exposes ${DEBUG_BRIDGE_MARKER} in ${bridgeFiles.slice(0, 3).join(", ")}: `
        + "do not ship the observation bridge in a public build",
    });
  }

  const assetFileCount = files.filter(file => /^(images|fonts|battle-anims)\//.test(file.path)).length;

  return {
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    largestFiles: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 5),
    assetFileCount,
    problems,
  };
}

/** Render a report for a log, including the numbers a deployment decision needs. */
export function formatReport(report: ArtifactReport, root: string): string {
  const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  const lines = [
    `[artifact] ${relative(process.cwd(), root) || "."}: ${report.fileCount} files, ${megabytes(report.totalBytes)}`,
    `[artifact] ${report.assetFileCount} files under images/, fonts/ and battle-anims/`,
    `[artifact] largest: ${report.largestFiles.map(file => `${file.path} (${megabytes(file.bytes)})`).join(", ")}`,
  ];

  for (const problem of report.problems) {
    lines.push(`[artifact] PROBLEM (${problem.code}): ${problem.message}`);
  }

  return lines.join("\n");
}

/** Throw when the artifact has any problem, so a build job fails instead of shipping. */
export function assertArtifact(report: ArtifactReport): void {
  if (report.problems.length > 0) {
    throw new Error(
      `the build artifact has ${report.problems.length} problem(s): ${report.problems.map(p => p.code).join(", ")}`,
    );
  }
}
