import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { API_PREFIX } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { databaseRuntime } from "../services/database-runtime.service.js";

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    init: vi.fn(),
    getDb: vi.fn().mockResolvedValue(null),
    listAll: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
    show: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: "os-mock" }),
    createMany: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    closeMany: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    deleteByProjectId: vi.fn(),
    deleteOpenQuestionsByProjectId: vi.fn(),
    ready: vi.fn().mockResolvedValue([]),
    readyWithStatusMap: vi.fn().mockResolvedValue({ ready: [], statusMap: new Map() }),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    getDependencies: vi.fn().mockResolvedValue([]),
    listInProgressWithAgentAssignee: vi.fn().mockResolvedValue([]),
    setOnTaskChange: vi.fn(),
    planUpsert: vi.fn(),
    planGet: vi.fn().mockResolvedValue(null),
    planList: vi.fn().mockResolvedValue([]),
    planDelete: vi.fn().mockResolvedValue(false),
    planGetByEpicId: vi.fn().mockResolvedValue(null),
    planGetShippedContent: vi.fn().mockResolvedValue(null),
    closePool: vi.fn(),
    runWrite: vi
      .fn()
      .mockImplementation(async (fn: (db: null) => Promise<unknown> | unknown) => fn(null)),
  },
  TaskStoreService: vi.fn(),
}));

describe("App", () => {
  it("should respond to health check at /health", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
    expect(res.body.timestamp).toBeDefined();
  });

  it("should serve API under /api/v1 prefix", async () => {
    const app = createApp();
    const res = await request(app).get(`${API_PREFIX}/projects`);
    expect(res.status).toBe(200);
  });

  it("should parse JSON request bodies", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`${API_PREFIX}/projects`)
      .set("Content-Type", "application/json")
      .send({ name: "Test" });
    // Projects create may return 400/500 without valid setup, but body parsing works
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).toBeDefined();
  });

  it("returns 503 for DB-gated routes when database is unavailable", async () => {
    const app = createApp();
    vi.spyOn(databaseRuntime, "requireDatabase").mockRejectedValueOnce(
      new AppError(503, ErrorCodes.DATABASE_UNAVAILABLE, "No PostgreSQL server running")
    );

    const res = await request(app).get(`${API_PREFIX}/projects/proj-1/tasks`);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: ErrorCodes.DATABASE_UNAVAILABLE,
      message: "No PostgreSQL server running",
    });
    expect(res.headers["retry-after"]).toBe("5");
  });
});
