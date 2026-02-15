import { Router, Request } from "express";
import { AuthService } from "../services/auth.service.js";
import type { ApiResponse, LoginRequest, LoginResponse } from "@opensprint/shared";

const authService = new AuthService();

export const authRouter = Router();

// POST /auth/login — Authenticate and return JWT
authRouter.post("/login", async (req: Request, res, next) => {
  try {
    const body = req.body as LoginRequest;
    const response = await authService.login(body.email, body.password);
    const result: ApiResponse<LoginResponse> = { data: response };
    res.json(result);
  } catch (err) {
    next(err);
  }
});
