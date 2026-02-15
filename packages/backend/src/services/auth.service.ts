import fs from "fs/promises";
import path from "path";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import type { LoginResponse } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";

const JWT_EXPIRY_HOURS = 24;
const JWT_SECRET_ENV = "OPENSPRINT_JWT_SECRET";

interface AuthConfig {
  email: string;
  passwordHash: string;
}

function getAuthConfigPath(): string {
  const dir = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", ".opensprint");
  return path.join(dir, "auth.json");
}

export class AuthService {
  /** Load auth config from ~/.opensprint/auth.json */
  private async loadAuthConfig(): Promise<AuthConfig> {
    const configPath = getAuthConfigPath();
    try {
      const data = await fs.readFile(configPath, "utf-8");
      const config = JSON.parse(data) as AuthConfig;
      if (!config.email || !config.passwordHash) {
        throw new AppError(500, "AUTH_CONFIG_INVALID", "Auth config missing email or passwordHash");
      }
      return config;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(401, "AUTH_NOT_CONFIGURED", "Authentication not configured. Create ~/.opensprint/auth.json with email and passwordHash.");
    }
  }

  /** Validate credentials and return JWT on success */
  async login(email: string, password: string): Promise<LoginResponse> {
    const trimmedEmail = (email ?? "").trim();
    if (!trimmedEmail) {
      throw new AppError(400, "INVALID_INPUT", "Email is required");
    }
    if (!password) {
      throw new AppError(400, "INVALID_INPUT", "Password is required");
    }

    const config = await this.loadAuthConfig();

    if (config.email.toLowerCase() !== trimmedEmail.toLowerCase()) {
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
    }

    const valid = await bcrypt.compare(password, config.passwordHash);
    if (!valid) {
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
    }

    const secret = process.env[JWT_SECRET_ENV] ?? "opensprint-dev-secret-change-in-production";
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + JWT_EXPIRY_HOURS);

    const token = jwt.sign(
      { sub: config.email },
      secret,
      { algorithm: "HS256", expiresIn: `${JWT_EXPIRY_HOURS}h` }
    );

    return {
      token,
      expiresAt: expiresAt.toISOString(),
    };
  }
}
