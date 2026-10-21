import { vi } from "vitest";
import { projectGitRuntimeCache } from "../services/project-git-runtime-cache.js";

/** Track background Git inspections so fixture cleanup can await their completion. */
export function trackProjectRuntimeRefreshes(): () => Promise<void> {
  const pending: Promise<void>[] = [];
  const getSnapshot = projectGitRuntimeCache.getSnapshot.bind(projectGitRuntimeCache);
  const snapshotSpy = vi
    .spyOn(projectGitRuntimeCache, "getSnapshot")
    .mockImplementation((...args) => {
      const snapshot = getSnapshot(...args);
      // Capture each generation immediately, including inspections superseded by
      // a settings update before teardown starts.
      pending.push(projectGitRuntimeCache.waitForRefresh(args[0]));
      return snapshot;
    });
  return async () => {
    // Settings responses return before inspection finishes. Its child process
    // retains the working directory on Windows until the inspection completes.
    await Promise.all(pending);
    snapshotSpy.mockRestore();
    projectGitRuntimeCache.clear();
  };
}
