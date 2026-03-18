import { PLAN_STATUS_ORDER } from "../constants/index.js";
/** Sort plans by status order (planning → building → in_review → complete) */
export function sortPlansByStatus(plans) {
  return [...plans].sort((a, b) => {
    const orderA = PLAN_STATUS_ORDER[a.status] ?? 999;
    const orderB = PLAN_STATUS_ORDER[b.status] ?? 999;
    return orderA - orderB;
  });
}
//# sourceMappingURL=plan.js.map
