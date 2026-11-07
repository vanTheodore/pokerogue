<!--
SPDX-FileCopyrightText: 2026 Pagefault Games

SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
// Deliberately does *not* mount the game: it exists so the E2E suite can exercise a
// real client-side navigation (mount -> unmount -> mount) instead of a page reload,
// which is what the "no duplicate canvas / no duplicate Phaser instance" guarantee
// must survive on route changes and HMR.
</script>

<svelte:head>
  <title>About PokéRogue</title>
</svelte:head>

<main class="about">
  <h1>PokéRogue</h1>
  <p>
    A Pokémon fangame heavily inspired by the roguelite genre. This route exists in the
    SvelteKit shell only as a navigation target for lifecycle tests.
  </p>
  <p><a id="back-to-game" href="/">Back to the game</a></p>
</main>

<style>
  .about {
    max-width: 40rem;
    padding: 2rem;
    margin: 0 auto;
    font-family: system-ui, sans-serif;
    color: #eee;
  }

  .about a {
    color: #da3838;
  }
</style>
