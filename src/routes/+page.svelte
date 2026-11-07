<!--
SPDX-FileCopyrightText: 2026 Pagefault Games

SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
import { onMount } from "svelte";
// NOTE: relative imports on purpose. tsconfig `#path` aliases are not resolvable from
// `.svelte` files in SvelteKit's SSR environment (see test/tests/host/route-imports.test.ts).
import { installDebugBridge } from "../host/debug-bridge";
import { type GameHostSnapshot, gameHost } from "../host/game-host";
import { PageGameLifecycle } from "../host/page-lifecycle";

/**
 * The route's whole job is to own the game lifecycle: mount -> start, unmount/hot-reload -> stop.
 *
 * The lease bookkeeping lives in `PageGameLifecycle` so that the first mount and the
 * "Try again" button share one code path (see that module: keeping them apart is how a retry
 * ends up destroying the game it just restarted).
 *
 * Ownership of the canvas container stays with `src/app.html` (`#app`) because `index.css`
 * sizes and centres it via `body > #app` selectors. Svelte therefore never renders inside
 * `#app`; it only reports status and failures outside it.
 */
const APP_CONTAINER_ID = "app";

let snapshot = $state<GameHostSnapshot>(gameHost.snapshot);
let retrying = $state(false);

/** Created on mount, released on destroy. */
let lifecycle: PageGameLifecycle | null = null;

onMount(() => {
  // Development only: exposes the observation bridge the Playwright suite reads.
  installDebugBridge();

  const unsubscribe = gameHost.subscribe(next => {
    snapshot = next;
  });

  lifecycle = new PageGameLifecycle({
    host: gameHost,
    resolveParent: () => document.getElementById(APP_CONTAINER_ID),
    onError: error => console.error("[host] Failed to start PokéRogue:", error),
  });

  void lifecycle.start();

  return () => {
    unsubscribe();
    void lifecycle?.stop();
  };
});

/**
 * "Try again": exactly what the initial mount does.
 *
 * @remarks
 * The retry keeps its lease — that is the whole point. Releasing it immediately would leave
 * the host with no consumer and destroy the instance straight away, because a failed boot
 * holds no other lease.
 */
async function retry(): Promise<void> {
  if (retrying) {
    return;
  }

  retrying = true;
  try {
    await lifecycle?.start();
  } finally {
    retrying = false;
  }
}
</script>

{#if snapshot.status === "failed"}
  <div class="host-error" role="alert">
    <p>PokéRogue could not start.</p>
    <pre>{snapshot.error}</pre>
    <button type="button" onclick={retry} disabled={retrying}>
      {retrying ? "Retrying…" : "Try again"}
    </button>
  </div>
{/if}

<style>
  .host-error {
    position: fixed;
    inset-inline: 0;
    bottom: 0;
    z-index: 10;
    padding: 1rem 1.5rem;
    font-family: system-ui, sans-serif;
    font-size: 0.875rem;
    color: #fff;
    background: rgb(0 0 0 / 85%);
  }

  .host-error pre {
    margin: 0.5rem 0;
    overflow-x: auto;
    white-space: pre-wrap;
  }

  .host-error button {
    padding: 0.25rem 0.75rem;
    color: #fff;
    cursor: pointer;
    background: #da3838;
    border: 0;
    border-radius: 4px;
  }

  .host-error button:disabled {
    cursor: default;
    opacity: 0.6;
  }
</style>
