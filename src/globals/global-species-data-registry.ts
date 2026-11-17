import { serviceRegistry } from "#app/service-registry";
import type { SpeciesDataRegistry } from "#data/species-data-registry";

export let speciesDataRegistry: SpeciesDataRegistry;

serviceRegistry.register("speciesDataRegistry", {
  reset: () => {
    speciesDataRegistry = undefined!;
  },
});

export function setSpeciesDataRegistry(registry: SpeciesDataRegistry): void {
  speciesDataRegistry = registry;
}
