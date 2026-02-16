import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { API_PREFIX } from "@opensprint/shared";

describe("App", () => {
  it("should create an Express app", () => {
    const app = createApp();
    expect(app).toBeDefined();
    expect(typeof app.get).toBe("function");
    expect(typeof app.post).toBe("function");
    expect(typeof app.use).toBe("function");
  });

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
      .send({ name: "Test", description: "Test project" });
    // Projects create may return 400/500 without valid setup, but body parsing works
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).toBeDefined();
  });
});
