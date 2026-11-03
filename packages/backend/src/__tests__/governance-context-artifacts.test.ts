import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureGovernanceContextArtifacts } from "../services/governance-context-artifacts.js";
describe("original task context retention", () => {
  it("retains complete requirement and dependency bytes independently of active-directory cleanup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-retain-"));
    try {
      await fs.mkdir(path.join(root, "deps"));
      await fs.writeFile(path.join(root, "spec.md"), "original specification");
      await fs.writeFile(path.join(root, "plan.md"), "original plan");
      await fs.writeFile(path.join(root, "deps", "os-1234.diff"), Buffer.from([0, 10, 255, 100]));
      const retained = await captureGovernanceContextArtifacts(root);
      await fs.rm(root, { recursive: true });
      expect(retained.complete).toBe(true);
      expect(Buffer.from(retained.files["spec.md"], "base64").toString()).toBe(
        "original specification"
      );
      expect(Buffer.from(retained.files["deps/os-1234.diff"], "base64")).toEqual(
        Buffer.from([0, 10, 255, 100])
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("marks missing or linked context incomplete rather than silently omitting inputs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-missing-"));
    try {
      expect((await captureGovernanceContextArtifacts(root)).complete).toBe(false);
      await fs.writeFile(path.join(root, "plan.md"), "plan");
      await fs.symlink("/etc/hosts", path.join(root, "spec.md"));
      expect(await captureGovernanceContextArtifacts(root)).toMatchObject({
        complete: false,
        files: {},
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
