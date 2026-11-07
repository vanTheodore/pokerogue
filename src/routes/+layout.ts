/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * The game is a browser-only canvas application (Phaser + WebGL + IndexedDB/localStorage).
 * Rendering it on a server has no value and would execute browser-only modules
 * (`#app/polyfills`, `#app/i18n`, Phaser itself) in Node.
 */
export const ssr = false;
