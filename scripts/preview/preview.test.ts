/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Deployment tests for the preview artifact: cache-busting manifest, routing and cache headers.
 *
 * @remarks
 * These run against a **throwaway artifact** built here from a handful of files, not against the
 * real 300 MiB `build/`. That is what makes it possible to test the things that only go wrong on
 * deployment day — a manifest that lists a file the deploy does not contain, a stale manifest that
 * does not change when an asset does, a route that needs a rewrite the host does not have — without
 * a 20 s build and a browser.
 *
 * The real artifact's *manifest* is validated by `scripts/preview/artifact.ts` during
 * `bun run build:preview`, and the served result by `e2e/preview.spec.ts`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildCacheManifest, contentStamp, listArtifactFiles, MANIFEST_FILE, writeCacheManifest } from "./manifest.ts";
import { cacheControlFor, createStaticServer } from "./serve-build.ts";

/** Minimal artifact with the same shape as the real one, including a nested asset. */
function makeArtifact(): string {
  const root = mkdtempSync(join(tmpdir(), "pokerogue-preview-"));
  const write = (path: string, contents: string): void => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), contents);
  };

  write("index.html", '<!doctype html><html><body><div id="app"></div></body></html>');
  write("200.html", '<!doctype html><html><body><div id="app"></div></body></html>');
  write("_app/immutable/entry/start.abc123.js", "console.log('app');");
  write("images/pokemon/1.png", "fake-png-bytes");
  write("battle-anims/tackle.json", '{"frames":[]}');
  write("fonts/pkmnems.ttf", "fake-font");
  write("locales/en/menu.json", '{"newGame":"New Game"}');
  write("starter-colors.json", '{"1":"#fff"}');
  write("about.html", "<!doctype html><html><body><h1>PokéRogue</h1></body></html>");

  return root;
}

describe("cache-busting manifest", () => {
  let root: string;

  beforeAll(() => {
    root = makeArtifact();
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("uses the shape the game reads (`manifest[path]`) and absolute URL keys", () => {
    const manifest = buildCacheManifest(root);

    expect(Object.keys(manifest)).toEqual(["manifest"]);
    expect(manifest.manifest["/images/pokemon/1.png"]).toBe(contentStamp("fake-png-bytes"));
    expect(manifest.manifest["/locales/en/menu.json"]).toBeGreaterThan(0);
    // The game normalises `./fonts/x.ttf` to `/fonts/x.ttf` before looking it up.
    expect(manifest.manifest["/fonts/pkmnems.ttf"]).toBeTypeOf("number");
  });

  test("lists every file in the artifact and nothing else", () => {
    const manifest = buildCacheManifest(root);
    const keys = Object.keys(manifest.manifest)
      .map(key => key.slice(1))
      .sort();

    expect(keys).toEqual(listArtifactFiles(root));
    // Every key resolves to a real file: a dangling entry turns a hit into a 404.
    for (const key of Object.keys(manifest.manifest)) {
      expect(listArtifactFiles(root)).toContain(key.slice(1));
    }
  });

  test("never lists itself", () => {
    writeFileSync(join(root, MANIFEST_FILE), JSON.stringify(buildCacheManifest(root)));
    expect(Object.keys(buildCacheManifest(root).manifest)).not.toContain(`/${MANIFEST_FILE}`);
  });

  test("is stable across rebuilds of unchanged content", () => {
    const first = JSON.stringify(buildCacheManifest(root));
    const second = JSON.stringify(buildCacheManifest(root));

    // A byte-identical rebuild must not bust the CDN: the stamp is content-derived, not mtime.
    expect(second).toBe(first);
  });

  test("changes only the stamp of the asset whose bytes changed", () => {
    const before = buildCacheManifest(root);
    writeFileSync(join(root, "images/pokemon/1.png"), "fake-png-bytes-v2");
    const after = buildCacheManifest(root);

    expect(after.manifest["/images/pokemon/1.png"]).not.toBe(before.manifest["/images/pokemon/1.png"]);
    expect(after.manifest["/locales/en/menu.json"]).toBe(before.manifest["/locales/en/menu.json"]);
    expect(after.manifest["/fonts/pkmnems.ttf"]).toBe(before.manifest["/fonts/pkmnems.ttf"]);
  });

  test("writes a minified file and reports its size", () => {
    const { entries, bytes } = writeCacheManifest(root);
    expect(entries).toBe(listArtifactFiles(root).length);
    expect(bytes).toBeGreaterThan(0);
  });
});

describe("static host rules", () => {
  let root: string;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    root = makeArtifact();
    writeCacheManifest(root);
    server = createStaticServer(root, 0);
    await new Promise<void>(resolve => server.on("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  test("serves hashed chunks immutably and everything else for a short time", async () => {
    const chunk = await fetch(`${base}/_app/immutable/entry/start.abc123.js`);
    expect(chunk.status).toBe(200);
    expect(chunk.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const image = await fetch(`${base}/images/pokemon/1.png`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("serves the manifest uncached, so a deploy is visible immediately", async () => {
    const response = await fetch(`${base}/${MANIFEST_FILE}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(cacheControlFor(`/${MANIFEST_FILE}`)).toBe("no-store");

    const manifest = (await response.json()) as { manifest: Record<string, number> };
    // The stamp the game would append must address the file that is actually served.
    const stamp = manifest.manifest["/images/pokemon/1.png"];
    // The stamp describes these bytes, so the `?t=` URL the game builds is a valid cache key.
    expect(stamp).toBe(contentStamp("fake-png-bytes"));

    const cached = await fetch(`${base}/images/pokemon/1.png?t=${stamp}`);
    expect(cached.status).toBe(200);
    expect(await cached.text()).toBe("fake-png-bytes");
  });

  test("answers conditional requests with 304, and a changed file with 200", async () => {
    const url = `${base}/locales/en/menu.json`;
    const first = await fetch(url);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const conditional = await fetch(url, { headers: { "If-None-Match": etag! } });
    expect(conditional.status).toBe(304);

    // What a deploy does: the asset changes, so the old validator must stop matching.
    writeFileSync(join(root, "locales/en/menu.json"), '{"newGame":"Nouvelle partie"}');
    const updated = await fetch(url, { headers: { "If-None-Match": etag! } });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ newGame: "Nouvelle partie" });
  });

  test("rewrites client-side routes to the SPA fallback and keeps real files", async () => {
    const about = await fetch(`${base}/about`);
    expect(about.status).toBe(200);
    expect(await about.text()).toContain("PokéRogue");

    // A prerendered route is served from its own file, not from the fallback.
    const aboutHtml = await fetch(`${base}/about.html`);
    expect(aboutHtml.status).toBe(200);

    // A missing *file* is a 404, never the shell: the game must see asset failures.
    const missing = await fetch(`${base}/images/missing.png`);
    expect(missing.status).toBe(404);
  });

  test("refuses to serve anything outside the artifact", async () => {
    const traversal = await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`);
    expect(traversal.status).toBe(404);
  });
});
