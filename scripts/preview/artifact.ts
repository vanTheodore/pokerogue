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
import { MANIFEST_FILE, readCacheManifest } from "./manifest.ts";

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
  /** Entries of the cache-busting manifest, or `null` when it is missing or unusable. */
  readonly manifestEntries: number | null;
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
  const manifestEntries = inspectCacheManifest(root, paths, problems);

  return {
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    largestFiles: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 5),
    assetFileCount,
    manifestEntries,
    problems,
  };
}

/**
 * Validate the cache-busting manifest against the files that are actually in the artifact.
 *
 * @remarks
 * `getCachedUrl()` appends `?t=<stamp>` for every path the manifest lists, so a manifest is only
 * useful if it is *complete* (an unlisted asset keeps whatever the CDN cached) and *honest* (a
 * listed path that does not exist turns a 200 into a busted URL). Both directions are checked:
 *
 * - every key must resolve to a file in the artifact (no stale or invented paths);
 * - every file the game can request through `getCachedUrl()` — `images/`, `battle-anims/`,
 *   `fonts/`, `locales/` and the top-level JSON data files — must be listed;
 * - the manifest must not list itself, and must not carry a shape the game ignores.
 *
 * @returns The number of entries, or `null` when the manifest is missing or unusable.
 */
function inspectCacheManifest(root: string, paths: ReadonlySet<string>, problems: ArtifactProblem[]): number | null {
  if (!paths.has(MANIFEST_FILE)) {
    problems.push({
      code: "missing-manifest",
      message:
        `${MANIFEST_FILE} is missing: every asset would be served without a \`?t=\` cache-buster `
        + "(see src/utils/fetch-utils.ts)",
    });
    return null;
  }

  let manifest: Record<string, number>;
  try {
    manifest = readCacheManifest(join(root, MANIFEST_FILE)).manifest;
  } catch (error) {
    problems.push({ code: "invalid-manifest", message: `${MANIFEST_FILE}: ${(error as Error).message}` });
    return null;
  }

  const keys = Object.keys(manifest);
  if (keys.length === 0) {
    problems.push({ code: "empty-manifest", message: `${MANIFEST_FILE} has no entries` });
    return 0;
  }

  inspectManifestEntries(manifest, keys, paths, problems);
  reportUnlistedCacheableFiles(keys, paths, problems);

  return keys.length;
}

/** A path is usable when it is absolute, stays inside the artifact and maps to a positive integer. */
function isUsableEntry(key: string, stamp: unknown): boolean {
  if (!key.startsWith("/") || key.includes("..") || key.includes("\\")) {
    return false;
  }
  return typeof stamp === "number" && Number.isSafeInteger(stamp) && stamp > 0;
}

/** Keys that are malformed or that point at a file the artifact does not contain. */
function inspectManifestEntries(
  manifest: Record<string, number>,
  keys: readonly string[],
  paths: ReadonlySet<string>,
  problems: ArtifactProblem[],
): void {
  const malformed: string[] = [];
  const dangling: string[] = [];

  for (const key of keys) {
    if (!isUsableEntry(key, manifest[key])) {
      malformed.push(key);
    } else if (!paths.has(key.slice(1))) {
      dangling.push(key);
    }
  }

  if (malformed.length > 0) {
    problems.push({
      code: "malformed-manifest-keys",
      message: `${MANIFEST_FILE} has ${malformed.length} unusable key(s), for example ${malformed.slice(0, 3).join(", ")}`,
    });
  }

  if (dangling.length > 0) {
    problems.push({
      code: "dangling-manifest-entries",
      message:
        `${MANIFEST_FILE} lists ${dangling.length} path(s) the artifact does not contain, `
        + `for example ${dangling.slice(0, 3).join(", ")}`,
    });
  }

  if (keys.includes(`/${MANIFEST_FILE}`)) {
    problems.push({
      code: "self-referential-manifest",
      message: `${MANIFEST_FILE} lists itself: its stamp would describe the previous build`,
    });
  }
}

/** Files the game fetches through `getCachedUrl()` but that the manifest does not list. */
function reportUnlistedCacheableFiles(
  keys: readonly string[],
  paths: ReadonlySet<string>,
  problems: ArtifactProblem[],
): void {
  // A `Set` of keys, not `keys.includes()`: this runs over ~30 000 files on every build.
  const keySet = new Set(keys);
  const unlisted = [...paths].filter(path => isCacheable(path) && !keySet.has(`/${path}`));

  if (unlisted.length > 0) {
    problems.push({
      code: "unlisted-cacheable-files",
      message:
        `${unlisted.length} cacheable file(s) are not in ${MANIFEST_FILE}, for example `
        + `${unlisted.slice(0, 3).join(", ")}: they could never be invalidated`,
    });
  }
}

/** Whether the game can append `?t=` to this path (see `getCachedUrl` call sites). */
function isCacheable(path: string): boolean {
  return /^(images|battle-anims|fonts|locales)\//.test(path) || (/^[^/]+\.json$/.test(path) && path !== MANIFEST_FILE);
}

/** Render a report for a log, including the numbers a deployment decision needs. */
export function formatReport(report: ArtifactReport, root: string): string {
  const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  const lines = [
    `[artifact] ${relative(process.cwd(), root) || "."}: ${report.fileCount} files, ${megabytes(report.totalBytes)}`,
    `[artifact] ${report.assetFileCount} files under images/, fonts/ and battle-anims/`,
    `[artifact] cache manifest: ${report.manifestEntries ?? "missing"} entries`,
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
