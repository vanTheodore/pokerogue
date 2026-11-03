/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Serve the static SvelteKit build (`build/`) the way a static host would.
 *
 * @remarks
 * This exists so the *built* artifact — not the dev server — can be opened in a browser and
 * played: `bun run preview:static`. It is also the server the production E2E project runs
 * against (`playwright.build.config.ts`), which is the only way to prove that the artifact
 * that would be deployed actually boots.
 *
 * The behaviour deliberately mirrors a static host instead of Vite's dev middleware:
 *
 * - unknown paths that look like documents (no file extension) are served `200.html` —
 *   SvelteKit's SPA fallback — because the app has client-side routes and a real host needs an
 *   equivalent rewrite rule (`try_files` / `_redirects` / `not_found_handling`);
 * - hashed build output under `/_app/immutable/` is served `immutable`, long-lived — that is
 *   what makes CDN caching work, and it is safe *only* because the names are hashed;
 * - the fallback document and the cache-busting manifest are served `no-store`, so a deploy is
 *   picked up immediately (the game fetches `/manifest.json` with `cache: "no-store"` too);
 * - everything else (assets, locales) gets a short cache, an `ETag` and `Last-Modified`, and
 *   answers `304 Not Modified` to a conditional request;
 * - traversal outside the artifact is rejected.
 *
 * It is a preview server: single process, no compression, no range requests. Those belong to
 * the CDN in front of it (see `docs/PREVIEW.md`).
 *
 * `createStaticServer()` is exported so `scripts/preview/preview.test.ts` can exercise the
 * routing and caching rules against a throwaway artifact instead of the real 300 MiB build.
 */

import { createReadStream, existsSync, type Stats, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_FILE } from "./manifest.ts";

/** Document served for client-side routes (SvelteKit's SPA fallback). */
const FALLBACK = "200.html";

/** MIME types the game actually requests. Anything else is served as bytes. */
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".map": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wav": "audio/wav",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

/** Cache policy per path class; see the header documentation above. */
export function cacheControlFor(pathname: string): string {
  // The manifest is how a deploy invalidates assets: caching it would pin the old stamps.
  if (pathname === `/${MANIFEST_FILE}`) {
    return "no-store";
  }
  if (pathname.startsWith("/_app/immutable/")) {
    return "public, max-age=31536000, immutable";
  }
  return pathname === "/" || pathname.endsWith(".html") ? "no-cache" : "public, max-age=3600";
}

/** Strong-enough validator: identity plus mtime, so a redeploy invalidates cached copies. */
function etagFor({ file, stats }: ResolvedFile): string {
  return `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}-${file.length.toString(16)}"`;
}

interface ResolvedFile {
  file: string;
  stats: Stats;
}

/** Resolve a URL path to a file inside `root`, or `null` if it escapes the root. */
export function resolveFile(root: string, pathname: string): ResolvedFile | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relative = normalize(decoded).replace(/^[/\\]+/, "");
  const file = join(root, relative);
  if (file !== root && !file.startsWith(root + sep)) {
    return null;
  }

  try {
    const stats = statSync(file);
    return stats.isFile() ? { file, stats } : null;
  } catch {
    return null;
  }
}

/** Send a file with explicit headers, or an empty body for `HEAD`/`304`. */
function sendFile(
  response: ServerResponse,
  resolved: ResolvedFile,
  cacheControl: string,
  options: { headOnly: boolean; notModified: boolean },
): void {
  const { file, stats } = resolved;
  const etag = etagFor(resolved);
  const headers = {
    "Cache-Control": cacheControl,
    "Content-Type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    ETag: etag,
    "Last-Modified": stats.mtime.toUTCString(),
  };

  if (options.notModified) {
    response.writeHead(304, headers);
    response.end();
    return;
  }

  response.writeHead(200, { ...headers, "Content-Length": String(stats.size) });
  if (options.headOnly) {
    response.end();
    return;
  }

  createReadStream(file).pipe(response);
}

/** Handle one request; exported for the routing tests. */
export function handleRequest(
  root: string,
  request: Partial<Pick<IncomingMessage, "url" | "method" | "headers">>,
  response: ServerResponse,
): void {
  const { pathname } = new URL(request.url ?? "/", "http://preview.invalid");
  const headOnly = request.method === "HEAD";
  const ifNoneMatch = request.headers?.["if-none-match"];
  const ifModifiedSince = request.headers?.["if-modified-since"];

  /** Serve `resolved` with the cache rules for `requestedPath`, honouring conditionals. */
  const serve = (resolved: ResolvedFile, requestedPath: string): void => {
    const notModified =
      (typeof ifNoneMatch === "string" && ifNoneMatch === etagFor(resolved))
      || (typeof ifModifiedSince === "string"
        && !Number.isNaN(Date.parse(ifModifiedSince))
        && resolved.stats.mtime <= new Date(ifModifiedSince));

    sendFile(response, resolved, cacheControlFor(requestedPath), { headOnly, notModified });
  };

  const found = resolveFile(root, pathname);
  if (found) {
    serve(found, pathname);
    return;
  }

  // A path without an extension is a client-side route: try `<route>.html`, then the SPA
  // fallback, exactly as a static host with an SPA rewrite would.
  if (pathname === "/" || !extname(pathname)) {
    const routeFile = resolveFile(root, `${pathname.replace(/\/$/, "")}.html`);
    if (routeFile) {
      serve(routeFile, `${pathname}.html`);
      return;
    }

    const fallback = resolveFile(root, `/${FALLBACK}`);
    if (fallback) {
      serve(fallback, `/${FALLBACK}`);
      return;
    }
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

/** Start a static server for `root`. `port: 0` lets the OS choose one. */
export function createStaticServer(root: string, port: number): Server {
  return createServer((request, response) => handleRequest(root, request, response)).listen(port, "0.0.0.0");
}

if (import.meta.main) {
  const root = process.env.PREVIEW_ROOT
    ? resolve(process.env.PREVIEW_ROOT)
    : resolve(fileURLToPath(new URL("../..", import.meta.url)), "build");
  const port = Number(process.env.PORT ?? 8100);

  if (!existsSync(join(root, FALLBACK))) {
    console.error(`[preview] no build at ${root}: run \`bun run build:preview\` first`);
    process.exit(1);
  }

  const server = createStaticServer(root, port);
  server.on("listening", () => {
    console.log(`[preview] serving ${root} on http://0.0.0.0:${(server.address() as { port: number }).port}`);
  });
}
