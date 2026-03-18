/**
 * Parse task definitions from plan markdown.
 * Used when syncing plan markdown updates to task store tasks.
 *
 * Supports:
 * - ## Tasks section with ### Title blocks (description = content until next ### or ##)
 * - ## Instructions section with ### N. Title blocks (same format)
 */
/**
 * Extract the content of a markdown section by heading.
 * Returns content between ## SectionName and the next ## or end of document.
 * Case-insensitive for section name.
 */
function extractSection(content, sectionName) {
  const normalized = content.replace(/\r\n/g, "\n");
  const re = new RegExp(`^##\\s+${escapeRegex(sectionName)}\\s*$`, "im");
  const match = normalized.match(re);
  if (!match) return "";
  const idx = match.index;
  const start = idx + match[0].length;
  const rest = normalized.slice(start);
  const nextHeading = rest.match(/\n##\s+/);
  const end = nextHeading ? nextHeading.index : rest.length;
  return rest.slice(0, end).trim();
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * Parse tasks from a section that uses ### Title format.
 * Each ### heading is a task title; the following content until the next ### or ## is the description.
 */
function parseTasksFromHeadings(sectionContent) {
  if (!sectionContent.trim()) return [];
  const tasks = [];
  const lines = sectionContent.split("\n");
  let currentTitle = "";
  let currentDesc = [];
  for (const line of lines) {
    const h3Match = line.match(/^###\s+(.+)$/);
    if (h3Match) {
      if (currentTitle) {
        tasks.push({
          title: currentTitle.trim(),
          description: currentDesc.join("\n").trim(),
        });
      }
      // Strip leading "N. " or "N) " from title (e.g. "1. Add login" -> "Add login")
      currentTitle = h3Match[1].replace(/^\d+[.)]\s*/, "").trim();
      currentDesc = [];
    } else if (currentTitle) {
      currentDesc.push(line);
    }
  }
  if (currentTitle) {
    tasks.push({
      title: currentTitle.trim(),
      description: currentDesc.join("\n").trim(),
    });
  }
  return tasks;
}
/**
 * Parse tasks from plan markdown content.
 * Looks for ## Tasks or ## Instructions section with ### Title blocks.
 * Returns empty array if no such section or no tasks found.
 */
export function parsePlanTasks(content) {
  if (!content?.trim()) return [];
  const tasksSection = extractSection(content, "Tasks");
  const instructionsSection = extractSection(content, "Instructions");
  const section = tasksSection || instructionsSection;
  if (!section) return [];
  return parseTasksFromHeadings(section);
}
//# sourceMappingURL=plan-tasks.js.map
