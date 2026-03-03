import type { Request, Response, NextFunction } from "express";
import { databaseRuntime } from "../services/database-runtime.service.js";

export async function requireDatabase(
  _req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await databaseRuntime.requireDatabase();
    next();
  } catch (err) {
    next(err);
  }
}
