/**
 * Zod-based request validation middleware for API routes.
 * All routes that accept params, query, or body should use validateParams / validateQuery / validateBody
 * so invalid input is rejected with 400 and clear error messages (security and error clarity).
 */
import type { Request, Response, NextFunction } from "express";
import type { z } from "zod";
import { AppError } from "./error-handler.js";
import { ErrorCodes } from "./error-codes.js";

function firstErrorMessage(schemaError: z.ZodError): string {
  const first = schemaError.issues[0];
  return first ? first.message : "Validation failed";
}

export function validateParams(schema: z.ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, firstErrorMessage(result.error));
    }
    req.params = result.data as Record<string, string>;
    next();
  };
}

export function validateQuery(schema: z.ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, firstErrorMessage(result.error));
    }
    req.query = result.data as Record<string, string>;
    next();
  };
}

export function validateBody(schema: z.ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, firstErrorMessage(result.error));
    }
    req.body = result.data;
    next();
  };
}
