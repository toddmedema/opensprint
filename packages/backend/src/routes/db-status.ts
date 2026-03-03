import { Router } from "express";
import type { ApiResponse } from "@opensprint/shared";
import { databaseRuntime, type DbStatusResponse } from "../services/database-runtime.service.js";

export const dbStatusRouter = Router();

/**
 * GET /db-status — Check PostgreSQL connectivity.
 * Returns { data: { ok: true } } when connected, or { data: { ok: false, message } } when not.
 * Used by the homepage to show an error banner when the backend cannot connect.
 */
dbStatusRouter.get("/", async (_req, res) => {
  try {
    const result = await databaseRuntime.getStatus({ triggerReconnect: true });
    res.json({ data: result } as ApiResponse<DbStatusResponse>);
  } catch {
    res.json({
      data: {
        ok: false,
        message: "Server is unable to connect to PostgreSQL database.",
        state: "disconnected",
        lastCheckedAt: null,
      },
    } as ApiResponse<DbStatusResponse>);
  }
});
