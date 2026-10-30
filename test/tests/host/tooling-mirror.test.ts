/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps Bun's dependency configuration in sync with the pnpm one.
 *
 * @remarks
 * Since Bun 1.4, `bun install` reads `pnpm-workspace.yaml` *once* and copies
 * `overrides`, `patchedDependencies` and `onlyBuiltDependencies` into `package.json`
 * (as `overrides`, `patchedDependencies`, `trustedDependencies`). After that it only
 * looks at `package.json`:
 *
 * - If the copied fields are removed, Bun silently installs the **unpatched**
 *   `@material/material-color-utilities` (verified: the patch disappears from
 *   `bun.lock` and from `node_modules`).
 * - If upstream changes `pnpm-workspace.yaml` (e.g. a new security override), the
 *   copy goes stale and Bun installs something different from pnpm.
 *
 * Both cases are silent, so they are pinned by this test. The fix is always
 * "edit `pnpm-workspace.yaml` and re-run `bun install`".
 */

const ROOT = resolve(import.meta.dirname, "../../..");

/** Value of a `key: value` line inside a block, as written in `pnpm-workspace.yaml`. */
function readYamlBlock(source: string, blockName: string): string[] {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex(line => line.trimEnd() === `${blockName}:`);
  if (start === -1) {
    return [];
  }

  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    // A block ends at the first line that is not indented.
    if (!line.startsWith(" ")) {
      break;
    }
    entries.push(line.trim());
  }
  return entries;
}

/** `'pkg@>=1 <2': '>=2'` -> `["pkg", ">=2"]` */
function parseOverride(line: string): [name: string, range: string] {
  const match = /^'?([^':]+)'?:\s*'?([^']+)'?$/.exec(line);
  if (!match) {
    throw new Error(`Could not parse override line: ${line}`);
  }
  return [match[1].trim(), match[2].trim()];
}

/** `'@scope/pkg': patches/x.patch` -> `["@scope/pkg", "patches/x.patch"]` */
function parseKeyValue(line: string): [string, string] {
  const separator = line.indexOf(":");
  return [line.slice(0, separator).replace(/^'|'$/g, "").trim(), line.slice(separator + 1).trim()];
}

/** Bun keys patches as `name@version`; strip the version so both sides compare equal. */
function stripVersion(key: string): string {
  return key.replace(/@[^@]+$/, "");
}

const workspaceSource = readFileSync(resolve(ROOT, "pnpm-workspace.yaml"), "utf-8");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as {
  overrides?: Record<string, string>;
  patchedDependencies?: Record<string, string>;
  trustedDependencies?: string[];
};

describe("Tooling - Bun/pnpm configuration mirror", () => {
  it("should mirror `overrides` from pnpm-workspace.yaml", () => {
    const pnpmOverrides = Object.fromEntries(readYamlBlock(workspaceSource, "overrides").map(parseOverride));

    expect(Object.keys(pnpmOverrides).length).toBeGreaterThan(0);
    expect(pkg.overrides).toEqual(pnpmOverrides);
  });

  it("should mirror `patchedDependencies` from pnpm-workspace.yaml", () => {
    const pnpmPatches = Object.fromEntries(readYamlBlock(workspaceSource, "patchedDependencies").map(parseKeyValue));

    expect(Object.keys(pnpmPatches).length).toBeGreaterThan(0);
    expect(pkg.patchedDependencies).toBeDefined();

    // Bun appends the resolved version to the key (`name@1.2.3`), pnpm does not.
    const bunPatches = Object.fromEntries(
      Object.entries(pkg.patchedDependencies ?? {}).map(([key, value]) => [stripVersion(key), value]),
    );
    expect(bunPatches).toEqual(pnpmPatches);
  });

  it("should mirror `onlyBuiltDependencies` as `trustedDependencies`", () => {
    const pnpmBuilt = readYamlBlock(workspaceSource, "onlyBuiltDependencies").map(line =>
      line.replace(/^- /, "").trim(),
    );

    expect(pnpmBuilt.length).toBeGreaterThan(0);
    expect(pkg.trustedDependencies).toEqual(pnpmBuilt);
  });

  it("should keep the patched dependency in the Bun lockfile", () => {
    const bunLock = readFileSync(resolve(ROOT, "bun.lock"), "utf-8");

    // Losing this block means Bun installed the unpatched package, which breaks typecheck.
    expect(bunLock).toContain('"patchedDependencies"');
    expect(bunLock).toContain("@material/material-color-utilities");
  });
});
