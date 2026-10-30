import { bootGame } from "./host/boot-game";

// Legacy MPA entry point (index.html). The SvelteKit host uses `#host/game-host` instead.
// Both paths share `bootGame` so the boot sequence has exactly one definition.
await bootGame({ parent: "app" });
