<!--
SPDX-FileCopyrightText: 2026 Pagefault Games

SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
import { onMount } from "svelte";
// NOTE: relative import on purpose. tsconfig `#path` aliases are not resolvable from
// `.svelte` files in SvelteKit's SSR environment (see test/tests/host/route-imports.test.ts).
import { installDebugBridge } from "../host/debug-bridge";
import { GameHostDisposedError, type GameHostSnapshot, type GameLease, gameHost } from "../host/game-host";

/**
 * The route's whole job is to own the game lifecycle:
 * mount -> `gameHost.acquire()`, unmount/hot-reload -> `lease.release()`.
 *
 * A lease (instead of a bare start/dispose pair) keeps the game alive when the new
 * component mounts *before* the previous one unmounts (client-side navigation, HMR),
 * and guarantees the instance is destroyed only when the last consumer is gone.
 *
 * Ownership of the canvas container stays with `src/app.html` (`#app`) because
 * `index.css` sizes and centres it via `body > #app` selectors. Svelte therefore
 * never renders inside `#app`; it only reports status and failures outside it.
 */
const APP_CONTAINER_ID = "app";

let snapshot = $state<GameHostSnapshot>(gameHost.snapshot);
let retrying = $state(false);

onMount(() => {
  // Development only: exposes the observation bridge the Playwright suite reads.
  installDebugBridge();

  const unsubscribe = gameHost.subscribe(next => {
    snapshot = next;
  });

  let lease: GameLease | null = null;
  let unmounted = false;
  // Set when the boot was cancelled because this component went away; not an error.
  let disposedDuringBoot = false;

  async function mountGame(): Promise<void> {
    const container = document.getElementById(APP_CONTAINER_ID);
    if (!container) {
      console.error(`[host] #${APP_CONTAINER_ID} is missing from the page template; the game cannot mount.`);
      return;
    }

    const acquired = await gameHost.acquire({ parent: container });

    if (unmounted) {
      // The component was destroyed while booting: hand the claim straight back so the
      // instance is not leaked.
      await acquired.release();
      return;
    }
    lease = acquired;
  }

  mountGame().catch(error => {
    if (error instanceof GameHostDisposedError) {
      disposedDuringBoot = true;
      return;
    }
    console.error("[host] Failed to start PokéRogue:", error);
  });

  return () => {
    unmounted = true;
    unsubscribe();

    const released = lease?.release() ?? Promise.resolve();
    released.catch(error => {
      if (!disposedDuringBoot) {
        console.error("[host] Failed to dispose PokéRogue:", error);
      }
    });
  };
});

async function retry(): Promise<void> {
  const container = document.getElementById(APP_CONTAINER_ID);
  if (!container || retrying) {
    return;
  }

  retrying = true;
  try {
    const lease = await gameHost.acquire({ parent: container });
    // Drop the extra claim immediately: the mount effect keeps its own.
    await lease.release();
  } catch (error) {
    if (!(error instanceof GameHostDisposedError)) {
      console.error("[host] Retry failed:", error);
    }
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
