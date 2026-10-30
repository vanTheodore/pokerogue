/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Prerender the shell so the static build contains a real `index.html`
 * (the game itself is client-only, see `+layout.ts`).
 */
export const prerender = true;
