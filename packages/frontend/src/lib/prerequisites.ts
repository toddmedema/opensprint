/**
 * Shared prerequisite definitions and install URL helper for Git and Node.js.
 * Used by HomeScreen, OnboardingPage, and CreateNewProjectPage.
 */

export const PREREQ_ITEMS = ["Git", "Node.js"] as const;

/**
 * Returns the install URL for a prerequisite tool. Uses platform from API (e.g. win32 → git-scm.com/download/win).
 */
export function getPrereqInstallUrl(tool: string, platform?: string): string {
  if (tool === "Git" && platform === "win32") return "https://git-scm.com/download/win";
  if (tool === "Git") return "https://git-scm.com/";
  if (tool === "Node.js") return "https://nodejs.org/";
  return "#";
}
