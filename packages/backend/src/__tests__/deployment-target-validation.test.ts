import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createProjectsRouter } from "../routes/projects.js";
import { createDeliverRouter } from "../routes/deliver.js";
import { errorHandler } from "../middleware/error-handler.js";
import type { ProjectService } from "../services/project.service.js";
import type { PlanService } from "../services/plan.service.js";

vi.mock("../services/orchestrator.service.js", () => ({
  orchestratorService: { refreshMaxSlotsAndNudge: vi.fn() },
}));

describe("deployment target request validation on both update routes", () => {
  it.each(["project", "deliver"])(
    "rejects malformed %s updates before persistence and preserves valid patches",
    async (route) => {
      let settings = {
        deployment: { mode: "custom", targets: [{ name: "existing", command: "deploy" }] },
        unrelated: "preserved",
      };
      const service = {
        getSettings: vi.fn(async () => settings),
        getSettingsWithRuntimeState: vi.fn(async () => settings),
        updateSettings: vi.fn(async (_id, patch) => {
          settings = { ...settings, ...patch };
          return settings;
        }),
      };
      const app = express();
      app.use(express.json());
      app.use(
        "/projects",
        createProjectsRouter(service as unknown as ProjectService, {} as PlanService)
      );
      app.use(
        "/projects/:projectId/deliver",
        createDeliverRouter(service as unknown as ProjectService)
      );
      app.use(errorHandler);
      const url = route === "project" ? "/projects/A/settings" : "/projects/A/deliver/settings";
      const body = (targets: unknown) =>
        route === "project" ? { deployment: { targets }, unrelated: "preserved" } : { targets };
      const before = structuredClone(settings);
      for (const targets of [
        { bad: true },
        [null],
        [{ name: "" }],
        [{ name: "ok", command: 2 }],
        [{ name: "ok", isDefault: "yes" }],
        [{ name: "ok", envVars: { X: 1 } }],
        [{ name: "ok", autoDeployTrigger: "invalid" }],
      ]) {
        expect((await request(app).put(url).send(body(targets))).status).toBe(400);
        expect(settings).toEqual(before);
        expect(service.updateSettings).not.toHaveBeenCalled();
      }
      const targets = [
        {
          name: "production",
          command: "",
          webhookUrl: "",
          isDefault: true,
          envVars: { X: "value" },
          autoDeployTrigger: "none",
        },
        { name: "beta" },
      ];
      for (const mode of ["custom", "expo"]) {
        const validBody =
          route === "project"
            ? { deployment: { mode, targets }, unrelated: "preserved" }
            : { mode, targets };
        expect((await request(app).put(url).send(validBody)).status).toBe(200);
        expect(settings.deployment.mode).toBe(mode);
      }
      expect(settings.deployment.targets).toEqual(targets);
      expect(settings.unrelated).toBe("preserved");
    }
  );
});
