<!--
SPDX-FileCopyrightText: 2026 Pagefault Games

SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
// The global stylesheet is a plain CSS file shared with the legacy MPA build;
// importing it here lets Vite fingerprint and serve it through SvelteKit.
import "../../index.css";

// Svelte 5 runes: the layout is the component that renders the page. Forgetting this
// declaration makes `children` undefined at runtime (the page renders nothing).
const { children } = $props();
</script>

{@render children()}
