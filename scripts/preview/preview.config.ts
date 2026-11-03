/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Vitest configuration for the preview build tooling (`scripts/preview`).
 *
 * @remarks
 * Separate from the root `vitest.config.ts` on purpose: the root suite runs in jsdom against
 * `test/tests/**`, while these tests are plain Node — they start a real HTTP server, write
 * temporary artifacts to disk and read files. The root suite's `include` does not match this
 * directory, so the two never overlap.
 *
 * Run with `bun run test:preview`.
 */

import { defineConfig } from "vitest/config";

// biome-ignore lint/style/noDefaultExport: required for vitest
export default defineConfig({
  test: {
    environment: "node",
    include: ["./scripts/preview/*.test.ts"],
    // Server tests bind real ports and touch the file system; parallelism buys nothing here.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
