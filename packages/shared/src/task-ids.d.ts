/**
 * Utilities for parsing hierarchical task IDs.
 * Task IDs follow the pattern: epic (e.g. opensprint.dev-xyz), tasks (epic.0, epic.1, epic.1.1).
 */
/**
 * Extract the epic prefix from a hierarchical task ID.
 * For "opensprint.dev-xyz.2.1" returns "opensprint.dev-xyz.2".
 * For "opensprint.dev-xyz.2" (epic itself, no trailing numeric segment) returns "opensprint.dev-xyz.2".
 *
 * @param id - A task ID (e.g. epic, task, sub-task)
 * @returns The epic ID (parent prefix when id ends with .digits, otherwise id)
 */
export declare function getEpicId(id: string): string;
//# sourceMappingURL=task-ids.d.ts.map
