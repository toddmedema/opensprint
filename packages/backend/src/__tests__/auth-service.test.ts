import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import bcrypt from "bcrypt";
import { AuthService } from "../services/auth.service.js";

describe("AuthService", () => {
  let authService: AuthService;
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    authService = new AuthService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-auth-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should return 401 when auth config does not exist", async () => {
    await expect(authService.login("user@test.com", "password")).rejects.toMatchObject({
      statusCode: 401,
      code: "AUTH_NOT_CONFIGURED",
    });
  });

  it("should return 400 when email is missing", async () => {
    const opensprintDir = path.join(tempDir, ".opensprint");
    await fs.mkdir(opensprintDir, { recursive: true });
    const hash = await bcrypt.hash("password", 10);
    await fs.writeFile(
      path.join(opensprintDir, "auth.json"),
      JSON.stringify({ email: "user@test.com", passwordHash: hash })
    );

    await expect(authService.login("", "password")).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_INPUT",
    });
  });

  it("should return 400 when password is missing", async () => {
    const opensprintDir = path.join(tempDir, ".opensprint");
    await fs.mkdir(opensprintDir, { recursive: true });
    const hash = await bcrypt.hash("password", 10);
    await fs.writeFile(
      path.join(opensprintDir, "auth.json"),
      JSON.stringify({ email: "user@test.com", passwordHash: hash })
    );

    await expect(authService.login("user@test.com", "")).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_INPUT",
    });
  });

  it("should return 401 when email does not match", async () => {
    const opensprintDir = path.join(tempDir, ".opensprint");
    await fs.mkdir(opensprintDir, { recursive: true });
    const hash = await bcrypt.hash("password", 10);
    await fs.writeFile(
      path.join(opensprintDir, "auth.json"),
      JSON.stringify({ email: "user@test.com", passwordHash: hash })
    );

    await expect(authService.login("other@test.com", "password")).rejects.toMatchObject({
      statusCode: 401,
      code: "INVALID_CREDENTIALS",
    });
  });

  it("should return 401 when password does not match", async () => {
    const opensprintDir = path.join(tempDir, ".opensprint");
    await fs.mkdir(opensprintDir, { recursive: true });
    const hash = await bcrypt.hash("password", 10);
    await fs.writeFile(
      path.join(opensprintDir, "auth.json"),
      JSON.stringify({ email: "user@test.com", passwordHash: hash })
    );

    await expect(authService.login("user@test.com", "wrongpassword")).rejects.toMatchObject({
      statusCode: 401,
      code: "INVALID_CREDENTIALS",
    });
  });

  it("should return token and expiresAt on valid login", async () => {
    const opensprintDir = path.join(tempDir, ".opensprint");
    await fs.mkdir(opensprintDir, { recursive: true });
    const hash = await bcrypt.hash("password", 10);
    await fs.writeFile(
      path.join(opensprintDir, "auth.json"),
      JSON.stringify({ email: "user@test.com", passwordHash: hash })
    );

    const result = await authService.login("user@test.com", "password");

    expect(result.token).toBeDefined();
    expect(typeof result.token).toBe("string");
    expect(result.token.split(".")).toHaveLength(3); // JWT format
    expect(result.expiresAt).toBeDefined();
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("should accept email case-insensitively", async () => {
    const opensprintDir = path.join(tempDir, ".opensprint");
    await fs.mkdir(opensprintDir, { recursive: true });
    const hash = await bcrypt.hash("password", 10);
    await fs.writeFile(
      path.join(opensprintDir, "auth.json"),
      JSON.stringify({ email: "User@Test.com", passwordHash: hash })
    );

    const result = await authService.login("user@test.com", "password");
    expect(result.token).toBeDefined();
  });
});
