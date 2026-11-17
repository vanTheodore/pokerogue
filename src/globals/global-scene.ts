import type { BattleScene } from "#app/battle-scene";
import { serviceRegistry } from "#app/service-registry";

export let globalScene: BattleScene;

serviceRegistry.register("globalScene", {
  reset: () => {
    globalScene = undefined!;
  },
});

export function initGlobalScene(scene: BattleScene): void {
  globalScene = scene;
}
