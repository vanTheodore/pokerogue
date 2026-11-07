/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Parity tests between the legacy HTML shell (`index.html`) and the SvelteKit app
 * template (`src/app.html`).
 *
 * `index.css` relies on structural selectors such as
 * `body:has(> #touchControls.visible) #app` and `#app > div:first-child`, and the game
 * code looks these elements up by id (`#app`, `#touchControls`, `#saveFile`, ...).
 * Both documents therefore have to keep the same shell markup, or the game will boot
 * with broken layout/controls in one pipeline but not the other.
 */

const ROOT = resolve(import.meta.dirname, "../../..");

function parseHtml(file: string): Document {
  const html = readFileSync(resolve(ROOT, file), "utf-8");
  return new DOMParser().parseFromString(html, "text/html");
}

/** Normalised markup of an element, ignoring formatting whitespace. */
function normalise(element: Element | null): string | null {
  return element?.outerHTML.replace(/\s+/g, " ").replace(/> </g, "><").trim() ?? null;
}

describe("Host - HTML shell parity", () => {
  const legacy = parseHtml("index.html");
  const kit = parseHtml("src/app.html");

  it("should expose #app as a direct child of body in both shells", () => {
    for (const [name, doc] of [
      ["index.html", legacy],
      ["src/app.html", kit],
    ] as const) {
      const app = doc.getElementById("app");
      expect(app, `${name} is missing #app`).not.toBeNull();
      expect(app?.parentElement?.tagName, `${name}: #app must be a direct child of <body>`).toBe("BODY");
    }
  });

  it("should expose #touchControls as a direct child of body in both shells", () => {
    for (const [name, doc] of [
      ["index.html", legacy],
      ["src/app.html", kit],
    ] as const) {
      const touchControls = doc.getElementById("touchControls");
      expect(touchControls, `${name} is missing #touchControls`).not.toBeNull();
      expect(touchControls?.parentElement?.tagName, `${name}: #touchControls must be a direct child of <body>`).toBe(
        "BODY",
      );
    }
  });

  it("should keep identical touch control markup", () => {
    expect(normalise(kit.getElementById("touchControls"))).toBe(normalise(legacy.getElementById("touchControls")));
  });

  it("should keep every element the game resolves by id", () => {
    // Ids from `document.getElementById(...)` calls in `src/` that must exist up front
    // (the others are created at runtime by Phaser or by game UI handlers).
    const requiredIds = ["app", "touchControls"];

    for (const id of requiredIds) {
      expect(legacy.getElementById(id), `index.html is missing #${id}`).not.toBeNull();
      expect(kit.getElementById(id), `src/app.html is missing #${id}`).not.toBeNull();
    }
  });

  it("should keep the SvelteKit placeholders the framework requires", () => {
    const raw = readFileSync(resolve(ROOT, "src/app.html"), "utf-8");

    expect(raw).toContain("%sveltekit.head%");
    expect(raw).toContain("%sveltekit.body%");
    // The legacy entry script must not be loaded by the SvelteKit shell (Phaser is
    // bootstrapped by `src/routes/+page.svelte` through `#host/game-host` instead).
    expect(raw).not.toContain("src/main.ts");
  });

  it("should keep the game font faces in both shells", () => {
    for (const [name, doc] of [
      ["index.html", legacy],
      ["src/app.html", kit],
    ] as const) {
      const styles = [...doc.querySelectorAll("style")].map(style => style.textContent ?? "").join("\n");
      expect(styles, `${name} is missing the emerald font face`).toContain("font-family: 'emerald'");
      expect(styles, `${name} is missing the pkmnems font face`).toContain("font-family: 'pkmnems'");
    }
  });
});
