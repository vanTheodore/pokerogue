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
 * - the fallback document is served `no-cache`, so a new deploy is picked up immediately;
 * - everything else (assets, locales) gets a short cache;
 * - traversal outside `build/` is rejected.
 *
 * It is a preview server: single process, no compression, no range requests. Those belong to
 * the CDN in front of it (see `docs/PREVIEW.md`).
 */

import { createReadStream, existsSync, type Stats, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)), "build");
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
function cacheControlFor(pathname: string): string {
  if (pathname.startsWith("/_app/immutable/")) {
    return "public, max-age=31536000, immutable";
  }
  return pathname === "/" || pathname.endsWith(".html") ? "no-cache" : "public, max-age=3600";
}

interface ResolvedFile {
  file: string;
  stats: Stats;
}

/** Resolve a URL path to a file inside `build/`, or `null` if it escapes the root. */
function resolveFile(pathname: string): ResolvedFile | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relative = normalize(decoded).replace(/^[/\\]+/, "");
  const file = join(ROOT, relative);
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    return null;
  }

  try {
    const stats = statSync(file);
    return stats.isFile() ? { file, stats } : null;
  } catch {
    return null;
  }
}

/** Send a file with explicit headers, or an empty body for `HEAD`. */
function sendFile(
  response: ServerResponse,
  { file, stats }: ResolvedFile,
  cacheControl: string,
  headOnly: boolean,
): void {
  response.writeHead(200, {
    "Cache-Control": cacheControl,
    "Content-Length": String(stats.size),
    "Content-Type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Last-Modified": stats.mtime.toUTCString(),
  });

  if (headOnly) {
    response.end();
    return;
  }

  createReadStream(file).pipe(response);
}

const port = Number(process.env.PORT ?? 8100);

if (!existsSync(join(ROOT, FALLBACK))) {
  console.error(`[preview] no build at ${ROOT}: run \`bun run build:preview\` first`);
  process.exit(1);
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://preview.invalid").pathname;
  const headOnly = request.method === "HEAD";

  const found = resolveFile(pathname);
  if (found) {
    sendFile(response, found, cacheControlFor(pathname), headOnly);
    return;
  }

  // A path without an extension is a client-side route: try `<route>.html`, then the SPA
  // fallback, exactly as a static host with an SPA rewrite would.
  if (pathname === "/" || !extname(pathname)) {
    const routeFile = resolveFile(`${pathname.replace(/\/$/, "")}.html`);
    if (routeFile) {
      sendFile(response, routeFile, "no-cache", headOnly);
      return;
    }

    const fallback = resolveFile(`/${FALLBACK}`);
    if (fallback) {
      sendFile(response, fallback, "no-cache", headOnly);
      return;
    }
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[preview] serving ${ROOT} on http://0.0.0.0:${port}`);
});
