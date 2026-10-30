import { taskStore } from "./task-store.service.js";
import { GovernanceService } from "./governance-store.js";
export { GovernanceService, DEFAULT_GOVERNANCE_CONFIG } from "./governance-store.js";
export const governanceService = new GovernanceService({
  getDb: () => taskStore.getDb(),
  runWrite: (fn) => taskStore.runWrite(fn),
  onNotification: async (notification) => {
    const { broadcastToProject } = await import("../websocket/index.js");
    broadcastToProject(notification.projectId, { type: "notification.added", notification });
  },
});
