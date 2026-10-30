<!--
SPDX-FileCopyrightText: 2026 Pagefault Games

SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
import { onMount } from "svelte";
// NOTE: relative import on purpose. tsconfig `#path` aliases are not resolvable from
// `.svelte` files in SvelteKit's SSR environment (see test/tests/host/route-imports.test.ts).
import { type GameHostSnapshot, gameHost } from "../host/game-host";

/**
 * The route's whole job is to own the game lifecycle:
 * mount -> `gameHost.start()`, unmount/hot-reload -> `gameHost.dispose()`.
 *
 * Ownership of the canvas container stays with `src/app.html` (`#app`) because
 * `index.css` sizes and centres it via `body > #app` selectors. Svelte therefore
 * never renders inside `#app`; it only reports status and failures outside it.
 */
const APP_CONTAINER_ID = "app";

let snapshot = $state<GameHostSnapshot>(gameHost.snapshot);
let retrying = $state(false);

onMount(() => {
  const unsubscribe = gameHost.subscribe(next => {
    snapshot = next;
  });

  const container = document.getElementById(APP_CONTAINER_ID);
  if (container) {
    void gameHost.start({ parent: container }).catch(error => {
      console.error("[host] Failed to start PokéRogue:", error);
    });
  } else {
    console.error(`[host] #${APP_CONTAINER_ID} is missing from the page template; the game cannot mount.`);
  }

  return () => {
    unsubscribe();
    void gameHost.dispose();
  };
});

async function retry(): Promise<void> {
  const container = document.getElementById(APP_CONTAINER_ID);
  if (!container || retrying) {
    return;
  }

  retrying = true;
  try {
    await gameHost.dispose();
    await gameHost.start({ parent: container });
  } catch (error) {
    console.error("[host] Retry failed:", error);
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
