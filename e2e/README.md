<!--
SPDX-FileCopyrightText: 2026 Pagefault Games

SPDX-License-Identifier: CC-BY-NC-SA-4.0
-->

# End-to-end acceptance tests

These tests boot the **real game** in a real Chromium: Phaser, WebGL, the SvelteKit shell and
the battle engine. They are the only automated check of the acceptance criteria that jsdom
cannot cover (rendering, input, the Svelte ↔ Phaser lifecycle, a playable slice).

## What is covered

| Test | Asserts |
| --- | --- |
| `boots exactly one Phaser instance inside #app` | The host reaches `running`, exactly one `<canvas>` exists in the document, and it lives inside `#app`. |
| `reaches the title screen` | Boot → title screen (`TitlePhase` / `TITLE`). |
| `loads the game fonts and renders the touch control shell` | The pixel font requested by `index.css` actually loaded, and the touch controls from `src/app.html` are present. |
| `does not duplicate the canvas across reloads` | A reload yields a fresh document with a single canvas. |
| `keeps a single game across a client-side navigation (remount)` | A SvelteKit client-side route change **unmounts** the game (canvas gone) and **remounts** it (one canvas, one instance, one lease). This is the case a page reload does not test. |
| `plays from the title screen into the first battle` | Title → New Game → Classic → starter selection → add to party → run start (wave 1) → FIGHT → first move → turn resolved. |

Input is delivered with the keyboard, exactly like a player (`Enter` = SUBMIT, `Space` =
ACTION), and the suite never calls into game internals to *drive* the game. It only *observes*
through the development-only bridge `window.__pokerogueHost__` (`src/host/game-host.ts`).

## Assets fixture

A full checkout of the `assets` submodule is ~1.7 GB. The tests need the sprites, fonts and
battle animations (≈380 MB), so CI does a **partial + sparse clone** of the pinned revision:

```
images/  fonts/  battle-anims/   (plus the root files: starter-colors.json, exp-sprites.json, …)
```

Excluded on purpose:

- `audio/` (~450 MB). The suite seeds the volume settings to zero; when an audio file is
  missing the game logs a load warning and continues. **Audio output is therefore not covered
  by these tests** — it cannot be verified on a headless CI runner anyway.
- Everything else that the client never fetches.

Nothing is stubbed or faked: the game loads real textures and real animations, and the missing
audio files are the only reduced input. If a test starts depending on audio, add `audio/` to the
sparse checkout and expect the job to be slower and ~450 MB heavier.

## Settings fixture

Before the page loads, `seedReturningPlayer` writes a `settings` entry into `localStorage`:

- `gameVersion: "99.9.9"` — skips the settings migrators, which assume a full save file and
  would otherwise throw on a partial object (the loader then silently keeps the defaults);
- `general.enableTutorials: false`, `general.playerGender: 1` — skips the first-run tutorial
  pages and the gender prompt, which are pure text and would add minutes per test;
- zero audio volumes.

These are user preferences, not gameplay: no scene, phase or battle rule is altered.

## Running locally

```sh
# 1. dependencies
bun install

# 2. translations (required by i18n)
git submodule update --init --depth 1 locales

# 3. assets fixture (sparse)
git clone --filter=blob:none --no-checkout --depth 1 \
  https://github.com/pagefaultgames/pokerogue-assets.git /tmp/pokerogue-assets
git -C /tmp/pokerogue-assets sparse-checkout set images fonts battle-anims
git -C /tmp/pokerogue-assets checkout "$(git ls-tree HEAD assets | awk '{print $3}')"
cp -a /tmp/pokerogue-assets/. assets/ && rm -rf assets/.git

# 4. browser + tests
bunx playwright install chromium
bun run test:e2e
```

`playwright.config.ts` starts the SvelteKit dev server (`bun run start:kit`) automatically and
reuses a running one outside CI.

### Running without Playwright's browser download

If the machine cannot reach the Playwright CDN (or you want to test a custom Chromium), point
`PLAYWRIGHT_EXECUTABLE_PATH` at the binary; the config forwards it to `launchOptions`.
For a container without a GPU this is often enough:

```sh
PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome bun run test:e2e
```

## Known constraints

- **Headless WebGL is software-rendered** (ANGLE/SwiftShader, configured in
  `playwright.config.ts`), so the game runs at a few frames per second and message text types
  slowly. Timeouts are deliberately generous; `pressUntil` presses a key only every 2.5 s,
  because presses that arrive while the game is animating are ignored.
- **The suite runs against the dev server**, because the observation bridge is only installed
  when `import.meta.env.DEV` is true. The production build of the same shell is covered by
  `bun run build:kit` plus the document parity test in `test/tests/host/`.
- **The backend is not exercised.** With `VITE_BYPASS_LOGIN=1` (`.env.development`) the game
  plays offline. Client ↔ server contracts are untouched by this migration and stay covered by
  the upstream suites; the Bun/Elysia backend is a later phase (see `docs/MIGRATION-PLAN.md`).
