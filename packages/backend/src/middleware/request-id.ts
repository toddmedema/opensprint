import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

/**
 * Middleware that assigns a unique request ID to each request and sets X-Request-Id header.
 * Use req.requestId in handlers and pass to logger for traceability.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const id = randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}
