/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, type Page, test } from "@playwright/test";
import { pressUntil, seedReturningPlayer, waitForRunningGame } from "./helpers.ts";

/**
 * Checks that only make sense against the **built** static artifact (`playwright.build.config.ts`).
 *
 * @remarks
 * `app.spec.ts` proves the game plays; this file proves the thing that would be *deployed*
 * behaves like a static site. Everything here is a difference between `vite dev` and `build/`
 * that has broken real static deployments:
 *
 * - hashed chunks have to be cacheable forever, and the shell must not be, or a deploy is
 *   invisible to returning visitors;
 * - client-side routes need an SPA fallback (`200.html`), because no `about.html` is generated;
 * - translations are fetched at runtime from a copied `locales/` directory, not bundled;
 * - the service worker registers (inert today, but it is part of the shipped shell);
 * - guest mode has to keep saves in `localStorage` across a reload, with no backend at all.
 *
 * It is skipped by the dev-server configuration (see the `testIgnore` in `playwright.config.ts`).
 */

const PRODUCTION_HOSTS = ["api.pokerogue.net", "apibeta.pokerogue.net", "127.0.0.1:9", "localhost:8001"];

/**
 * Responses that are expected to 404.
 *
 * @remarks
 * - `/audio/...`: the audio assets (~450 MB) are outside the CI fixture (see `e2e/README.md`).
 * `/manifest.json` is *not* on this list: the build generates it (`scripts/preview/manifest.ts`),
 * so a 404 there would be a real failure.
 */
function isExpectedMissing(url: string): boolean {
  return url.includes("/audio/");
}

/** Boot the artifact and fail with the host error if it cannot start. */
async function bootGame(page: Page): Promise<void> {
  await page.goto("/");
  await waitForRunningGame(page);
}

test.describe("Static preview artifact", () => {
  test("serves hashed chunks immutably and the shell without caching", async ({ request }) => {
    const shell = await request.get("/");
    expect(shell.status()).toBe(200);
    expect(shell.headers()["cache-control"]).toBe("no-cache");

    const chunkPath = (await shell.text()).match(/\/_app\/immutable\/entry\/start\.[\w-]+\.js/)?.[0];
    expect(chunkPath, "the shell does not reference a hashed entry chunk").toBeTruthy();

    const chunk = await request.get(chunkPath!);
    expect(chunk.status()).toBe(200);
    // The whole CDN story rests on this: the name is content-hashed, so it can never go stale.
    expect(chunk.headers()["cache-control"]).toContain("immutable");
    expect(chunk.headers()["content-type"]).toContain("javascript");

    const fallback = await request.get("/200.html");
    expect(fallback.status()).toBe(200);
    expect(fallback.headers()["cache-control"]).toBe("no-cache");
  });

  test("serves the web manifest and every icon it declares", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("manifest");

    const manifest = (await response.json()) as { icons: { src: string; sizes: string; type: string }[] };
    expect(manifest.icons.length).toBeGreaterThan(0);

    for (const icon of manifest.icons) {
      const iconResponse = await request.get(`/${icon.src}`);
      expect(iconResponse.status(), `manifest icon ${icon.src}`).toBe(200);
      expect(iconResponse.headers()["content-type"]).toBe("image/png");
    }
  });

  test("ships a cache-busting manifest whose entries address real files", async ({ request }) => {
    const response = await request.get("/manifest.json");
    expect(response.status()).toBe(200);
    // The game fetches it with `cache: "no-store"`; the header must not contradict that.
    expect(response.headers()["cache-control"]).toBe("no-store");

    const body = (await response.json()) as { manifest: Record<string, unknown> };
    const keys = Object.keys(body.manifest);
    expect(keys.length).toBeGreaterThan(30_000);
    expect(typeof body.manifest["/locales/en/menu.json"]).toBe("number");
    expect(typeof body.manifest["/images/pokemon/1.png"]).toBe("number");

    // The manifest must never advertise itself or a path the artifact cannot serve.
    expect(keys).not.toContain("/manifest.json");
    expect(keys.every(key => key.startsWith("/"))).toBe(true);

    // Every entry the game could append `?t=` to must resolve. Sampling a spread of entries keeps
    // this fast while covering the shapes that exist (sprites, animation JSON, fonts, locales).
    const sample = [
      "/images/pokemon/1.png",
      "/fonts/pkmnems.ttf",
      "/locales/en/menu.json",
      ...keys.filter(key => key.startsWith("/battle-anims/")).slice(0, 2),
      ...keys.filter(key => key.startsWith("/images/") && key.endsWith(".png")).slice(1000, 1003),
    ];

    for (const path of sample) {
      const stamp = body.manifest[path];
      expect(typeof stamp, `${path} is not in the manifest`).toBe("number");

      const bare = await request.get(path);
      expect(bare.status(), path).toBe(200);

      // The URL the game actually builds (`getCachedUrl`) has to work *and* return those bytes.
      const busted = await request.get(`${path}?t=${stamp}`);
      expect(busted.status(), `${path}?t=${stamp}`).toBe(200);
      expect(await busted.body()).toEqual(await bare.body());
    }
  });

  test("serves translations from the copied locales directory", async ({ request }) => {
    for (const locale of ["en", "es-ES"]) {
      const response = await request.get(`/locales/${locale}/menu.json`);
      expect(response.status(), `locales/${locale}/menu.json`).toBe(200);

      const messages = (await response.json()) as Record<string, string>;
      // Not just "a JSON file": the namespace the title screen needs, with real content.
      expect(Object.keys(messages).length).toBeGreaterThan(10);
    }
  });

  test("reaches a client-side route through the SPA fallback", async ({ page }) => {
    const failed: string[] = [];
    page.on("response", response => {
      if (response.status() >= 400) {
        failed.push(`${response.status()} ${response.url()}`);
      }
    });

    // `about` is not prerendered: no `about.html` exists in the artifact, so this only works if
    // the host rewrites unknown document paths to the fallback, as the preview server does.
    await page.goto("/about");
    await expect(page.locator("h1")).toHaveText("PokéRogue");
    await expect(page.locator("#back-to-game")).toBeVisible();

    // The fallback document is the full app shell, not a bare error page.
    expect(page.url()).toContain("/about");
    expect(failed).toEqual([]);
  });

  test("registers its service worker and keeps every request on the artifact", async ({ page }) => {
    test.slow();

    const missing: string[] = [];
    const backend: string[] = [];
    const locales: string[] = [];

    page.on("response", response => {
      const url = response.url();
      if (response.status() >= 400 && !isExpectedMissing(url)) {
        missing.push(`${response.status()} ${url}`);
      }
      if (PRODUCTION_HOSTS.some(host => url.includes(host))) {
        backend.push(url);
      }
      if (url.includes("/locales/")) {
        locales.push(url);
      }
    });

    await seedReturningPlayer(page);
    await bootGame(page);

    // The worker is served by the artifact and becomes the page's controller (it calls
    // `clients.claim()` on activation). It has no `fetch` handler today; what matters here is
    // that registering it does not break a static deploy.
    const workerState = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) {
        return "unsupported";
      }
      const registration = await navigator.serviceWorker.ready;
      const controller = navigator.serviceWorker.controller;
      return registration.active?.state === "activated" && controller !== null ? "controlling" : "not-controlling";
    });
    expect(workerState).toBe("controlling");

    // Translations are fetched from `/locales/...` at runtime; at least one must have been
    // served, and none may have failed (the `response` handler above covers the latter).
    expect(locales.length).toBeGreaterThan(0);

    // Guest mode: no account, no session bootstrap, no call to any backend.
    expect(backend).toEqual([]);
    expect(missing).toEqual([]);
  });

  test("keeps a guest save in localStorage across a reload", async ({ page }) => {
    test.slow();

    await seedReturningPlayer(page);
    await bootGame(page);

    await pressUntil(page, "Enter", snapshot => snapshot.uiModeName === "TITLE", "the title screen");
    await pressUntil(
      page,
      "Enter",
      snapshot => snapshot.uiModeName === "OPTION_SELECT" || snapshot.uiModeName === "STARTER_SELECT",
      "the game mode menu",
    );
    await pressUntil(page, "Enter", snapshot => snapshot.uiModeName === "STARTER_SELECT", "the starter screen");
    await pressUntil(page, " ", snapshot => snapshot.uiModeName === "OPTION_SELECT", "the starter action menu");
    await pressUntil(page, "Enter", snapshot => snapshot.uiModeName === "STARTER_SELECT", "the starter menu to close");
    const inRun = await pressUntil(
      page,
      "Enter",
      snapshot => snapshot.uiModeName === "COMMAND" && snapshot.waveIndex !== null,
      "the battle command menu",
      { maxPresses: 60, timeout: 180_000 },
    );
    expect(inRun.waveIndex).toBe(1);
    // A run-specific fingerprint: it lives in the save, and a new run cannot reproduce it.
    expect(inRun.leadPokemonId).not.toBeNull();

    /**
     * SHA-256 and byte length of every `localStorage` value.
     *
     * @remarks
     * Comparing lengths would pass on any corruption that preserves the size — a save written
     * under a different key, a truncated-then-padded payload, or a value that changed entirely
     * but happens to be as long as the old one. The digests compare the *content* of a ~500 kB
     * save without moving it out of the browser.
     */
    const readSave = (): Promise<Record<string, { bytes: number; sha256: string }>> =>
      page.evaluate(async () => {
        const entries = await Promise.all(
          Object.entries(localStorage).map(async ([key, value]) => {
            const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
            const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
            return [key, { bytes: value.length, sha256 }] as const;
          }),
        );
        return Object.fromEntries(entries);
      });

    const beforeReload = await readSave();
    expect(beforeReload.sessionData_Guest?.bytes, "no session was written to localStorage").toBeGreaterThan(1_000);
    expect(beforeReload.data_Guest?.bytes, "no system save was written to localStorage").toBeGreaterThan(1_000);

    // A reload throws away the whole JavaScript heap: anything that survives is on disk.
    await page.reload();
    await waitForRunningGame(page);

    const afterReload = await readSave();
    expect(afterReload.sessionData_Guest).toEqual(beforeReload.sessionData_Guest);
    expect(afterReload.data_Guest).toEqual(beforeReload.data_Guest);

    // And the game can read it back: at the title screen `checkLastSaveSlot` scans the five slots
    // and only sets `sessionSlotId` when it finds *and parses* one. Guest saves live in slot 0
    // (`sessionData_Guest`, see `getSessionDataLocalStorageKey`).
    const titleState = await pressUntil(page, "Enter", snapshot => snapshot.uiModeName === "TITLE", "the title screen");
    expect(titleState.sessionSlotId, "the game did not find the saved session").toBe(0);
    expect(titleState.waveIndex).toBeNull();

    // With a session available the title screen's first entry is "Continue": SUBMIT resumes the
    // run. Reaching the *command menu* again on the same wave and the same turn — with the party
    // intact, i.e. without going through starter selection — is the difference between "the bytes
    // are still in localStorage" and "the run is playable again".
    //
    // The `phase` is deliberately not used as the signal here: while the session is being
    // restored the scene still reports `TitlePhase`, even though the battle data is already there.
    const backInControl = await pressUntil(
      page,
      "Enter",
      snapshot => snapshot.uiModeName === "COMMAND" && snapshot.waveIndex === inRun.waveIndex,
      "the command menu of the resumed battle",
      { maxPresses: 60, timeout: 180_000 },
    );
    expect(backInControl.turn, "the resumed run is not on the turn it was saved on").toBe(inRun.turn);
    expect(backInControl.partySize, "the resumed run did not keep its party").toBe(1);
    expect(backInControl.leadPokemonId, "the run that came back is not the saved one").toBe(inRun.leadPokemonId);
  });
});
