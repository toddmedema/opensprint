import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import bcrypt from "bcrypt";
import { createApp } from "../app.js";
import { API_PREFIX } from "@opensprint/shared";

describe("POST /auth/login", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-auth-route-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should return 401 when auth config does not exist", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: "user@test.com", password: "password" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("AUTH_NOT_CONFIGURED");
  });

  it("should return token on valid credentials", async () => {
    const opensprintDir = path.join(tempDir, ".opensprint");
    await fs.mkdir(opensprintDir, { recursive: true });
    const hash = await bcrypt.hash("secret123", 10);
    await fs.writeFile(
      path.join(opensprintDir, "auth.json"),
      JSON.stringify({ email: "admin@opensprint.dev", passwordHash: hash })
    );

    const app = createApp();
    const res = await request(app)
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: "admin@opensprint.dev", password: "secret123" });

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.expiresAt).toBeDefined();
  });

  it("should return 401 on invalid password", async () => {
    const opensprintDir = path.join(tempDir, ".opensprint");
    await fs.mkdir(opensprintDir, { recursive: true });
    const hash = await bcrypt.hash("secret123", 10);
    await fs.writeFile(
      path.join(opensprintDir, "auth.json"),
      JSON.stringify({ email: "admin@opensprint.dev", passwordHash: hash })
    );

    const app = createApp();
    const res = await request(app)
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: "admin@opensprint.dev", password: "wrong" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });
});
