import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createFeedbackRouter } from "../routes/feedback.js";
import { errorHandler, AppError } from "../middleware/error-handler.js";
import { authedSupertest } from "./local-auth-test-helpers.js";

const run = vi.hoisted(() => vi.fn());
vi.mock("../services/automated-qa.service.js", () => ({
  AutomatedQaService: vi.fn().mockImplementation(() => ({ run })),
}));

describe("automated QA endpoint", () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/projects/:projectId/feedback",
    createFeedbackRouter({
      feedbackService: {
        listFeedback: vi.fn(),
        submitFeedback: vi.fn(),
        getFeedback: vi.fn(),
        recategorizeFeedback: vi.fn(),
        resolveFeedback: vi.fn(),
        cancelFeedback: vi.fn(),
      },
      orchestratorService: { nudge: vi.fn() },
    })
  );
  app.use(errorHandler);
  beforeEach(() => vi.clearAllMocks());

  it("passes validated perspectives and trimmed instructions to QA and returns per-perspective results", async () => {
    const result = {
      runId: "qa-1",
      results: [
        { perspective: "general", status: "completed", summary: "Tests passed", feedbackIds: [] },
      ],
    };
    run.mockResolvedValue(result);
    const response = await authedSupertest(app)
      .post("/projects/p1/feedback/automated-qa")
      .send({ perspectives: ["general", "code_quality"], instructions: "  Check architecture  " });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(result);
    expect(run).toHaveBeenCalledWith("p1", {
      perspectives: ["general", "code_quality"],
      instructions: "Check architecture",
    });
  });

  it.each([
    { perspectives: [] },
    { perspectives: ["unknown"] },
    { perspectives: ["general"], instructions: 42 },
  ])("rejects malformed payloads before launching agents: %j", async (body) => {
    const response = await authedSupertest(app)
      .post("/projects/p1/feedback/automated-qa")
      .send(body);
    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns an explicit conflict when a pass is already running", async () => {
    run.mockRejectedValue(
      new AppError(
        409,
        "ALREADY_EXISTS",
        "An automated QA pass is already running for this project."
      )
    );
    const response = await authedSupertest(app)
      .post("/projects/p1/feedback/automated-qa")
      .send({ perspectives: ["general"] });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("ALREADY_EXISTS");
  });
});
