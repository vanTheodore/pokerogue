/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Generation of the cache-busting manifest the game fetches at boot.
 *
 * @remarks
 * ## What upstream does
 *
 * `src/init/init-manifest.ts` fetches `/manifest.json` and passes its **`manifest`** property to
 * `initializeManifest()`. `getCachedUrl()` (`src/utils/fetch-utils.ts`) then looks a request path
 * up in that map and appends `?t=<value>` when the path is present:
 *
 * ```jsonc
 * { "manifest": { "/images/pokemon/1.png": 1759000000, ... } }
 * ```
 *
 * Upstream produces that file *outside* the repository: `deploy.yml` rsyncs the build with
 * `--no-times --checksum` and then runs a private tool (`~/prmanifest --inpath <dir>
 * --outpath <dir>/manifest.json`) on the server. Because rsync keeps the old mtime of files it did
 * not rewrite, the resulting stamp is a *per-file* invalidation key: it changes exactly when that
 * file's bytes changed. Since the tool is not public, the contract above is reconstructed from its
 * only consumer, and this module reproduces the *semantics*, not the byte-for-byte output.
 *
 * ## What this module does
 *
 * The stamp is derived from the file's **content** (the first 12 hex digits of its SHA-256, as an
 * integer) instead of its mtime:
 *
 * - invalidation semantics are identical — the stamp changes if and only if the bytes change;
 * - it is reproducible: two builds of the same commit produce the same manifest, so a rebuild does
 *   not bust the CDN for files nobody touched (mtime-based stamps cannot do this in a clean build,
 *   where every file is written anew);
 * - it stays a JSON number, so `?t=` keeps its shape.
 *
 * Two files can only collide by sharing a 48-bit prefix of the hash, and a collision would merely
 * mean two files are invalidated together.
 *
 * ## What it deliberately does not do
 *
 * - It only lists files that exist **inside the artifact**: a path that the site cannot serve is
 *   worse than no entry at all (the game would request `?t=` on a 404).
 * - It never lists itself: `manifest.json` is written after the walk, and its own stamp would
 *   describe the previous run.
 * - It does not filter by extension. Upstream's manifest covers the deployed tree, and
 *   `getCachedUrl()` is generic; narrowing it here would silently leave some requests fresh-cached.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix, sep } from "node:path";

/** Name of the generated file, relative to the artifact root. */
export const MANIFEST_FILE = "manifest.json";

/** Shape the game expects: `manifest["manifest"]["/path"] === stamp`. */
export interface CacheManifest {
  readonly manifest: Record<string, number>;
}

/**
 * Files that are never listed.
 *
 * @remarks
 * Only the manifest itself: it is generated from the tree it lives in.
 */
const ALWAYS_EXCLUDED = new Set([MANIFEST_FILE]);

/** Every file in `root`, as POSIX paths relative to it, sorted for a deterministic output. */
export function listArtifactFiles(root: string, prefix = ""): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(prefix ? join(root, prefix) : root, { withFileTypes: true })) {
    const relative = prefix ? posix.join(prefix.split(sep).join("/"), entry.name) : entry.name;

    if (entry.isDirectory()) {
      files.push(...listArtifactFiles(root, relative));
    } else if (entry.isFile() && !ALWAYS_EXCLUDED.has(relative)) {
      files.push(relative);
    }
  }

  return files.sort();
}

/**
 * Invalidation stamp for a file: a 48-bit integer derived from its content.
 *
 * @remarks
 * `Number.parseInt` of 12 hex digits is at most `2^48 - 1`, well inside the exact-integer range,
 * so the value survives `JSON.parse` in the browser unchanged.
 */
export function contentStamp(bytes: Buffer | string): number {
  return Number.parseInt(createHash("sha256").update(bytes).digest("hex").slice(0, 12), 16);
}

/** Build the manifest for the artifact at `root`, keyed by the URLs the game requests. */
export function buildCacheManifest(root: string): CacheManifest {
  const manifest: Record<string, number> = {};

  for (const relative of listArtifactFiles(root)) {
    manifest[`/${relative}`] = contentStamp(readFileSync(join(root, relative)));
  }

  return { manifest };
}

/** Write `manifest.json` into the artifact. Returns the number of entries written. */
export function writeCacheManifest(root: string): { entries: number; bytes: number } {
  const manifest = buildCacheManifest(root);
  const json = JSON.stringify(manifest);
  writeFileSync(join(root, MANIFEST_FILE), json);

  return { entries: Object.keys(manifest.manifest).length, bytes: Buffer.byteLength(json) };
}

/** Read and validate a manifest from an artifact, throwing on a shape the game cannot use. */
export function readCacheManifest(file: string): CacheManifest {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));

  if (typeof parsed !== "object" || parsed === null || !("manifest" in parsed)) {
    throw new Error(`${file} has no \`manifest\` property: the game would ignore it`);
  }

  const { manifest } = parsed as CacheManifest;
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error(`${file}: \`manifest\` must be an object mapping paths to stamps`);
  }

  return parsed as CacheManifest;
}
