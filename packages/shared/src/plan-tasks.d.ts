/**
 * Parse task definitions from plan markdown.
 * Used when syncing plan markdown updates to task store tasks.
 *
 * Supports:
 * - ## Tasks section with ### Title blocks (description = content until next ### or ##)
 * - ## Instructions section with ### N. Title blocks (same format)
 */
export interface ParsedPlanTask {
  title: string;
  description: string;
}
/**
 * Parse tasks from plan markdown content.
 * Looks for ## Tasks or ## Instructions section with ### Title blocks.
 * Returns empty array if no such section or no tasks found.
 */
export declare function parsePlanTasks(content: string): ParsedPlanTask[];
//# sourceMappingURL=plan-tasks.d.ts.map
