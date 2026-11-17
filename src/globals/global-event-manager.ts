import { serviceRegistry } from "#app/service-registry";
import { TimedEventManager } from "#app/timed-event-manager";

export const timedEventManager = new TimedEventManager();

serviceRegistry.register("timedEventManager", {
  reset: () => timedEventManager.reset(),
});
