import { Router, Request } from "express";
import { readdir, stat, mkdir } from "fs/promises";
import path from "path";
import { join, resolve, dirname } from "path";
import { existsSync } from "fs";
import type { ApiResponse } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { detectTestFramework } from "../services/test-framework.service.js";

const FS_ALLOWED_ROOT = process.env.OPENSPRINT_FS_ROOT
  ? path.resolve(process.env.OPENSPRINT_FS_ROOT)
  : path.resolve(process.cwd());

function isPathUnderRoot(resolvedPath: string): boolean {
  const normalized = path.normalize(resolvedPath);
  const relative = path.relative(FS_ALLOWED_ROOT, normalized);
  return (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)));
}

export const fsRouter = Router();

interface BrowseResult {
  current: string;
  parent: string | null;
  entries: { name: string; path: string; isDirectory: boolean }[];
}

// GET /fs/browse?path=/some/path — List directory contents
fsRouter.get(
  "/browse",
  async (req: Request<object, object, object, { path?: string }>, res, next) => {
    try {
      const rawPath = req.query.path;
      const targetPath = rawPath?.trim()
        ? resolve(rawPath)
        : resolve(process.env.HOME || process.env.USERPROFILE || "/");

      if (!isPathUnderRoot(targetPath)) {
        throw new AppError(400, ErrorCodes.INVALID_INPUT, "Path is outside the allowed directory.");
      }
      if (!existsSync(targetPath)) {
        throw new AppError(404, ErrorCodes.NOT_FOUND, "Directory does not exist");
      }

      const pathStat = await stat(targetPath);
      if (!pathStat.isDirectory()) {
        throw new AppError(400, ErrorCodes.NOT_DIRECTORY, "Path is not a directory");
      }

      const entries = await readdir(targetPath, { withFileTypes: true });
      const dirEntries = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          path: join(targetPath, e.name),
          isDirectory: true,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

      const parentPath = dirname(targetPath);
      const result: BrowseResult = {
        current: targetPath,
        parent: parentPath !== targetPath ? parentPath : null,
        entries: dirEntries,
      };

      const body: ApiResponse<BrowseResult> = { data: result };
      res.json(body);
    } catch (err) {
      next(err);
    }
  }
);

interface CreateFolderBody {
  parentPath: string;
  name: string;
}

// POST /fs/create-folder — Create a new folder and return its path
fsRouter.post(
  "/create-folder",
  async (req: Request<object, object, CreateFolderBody>, res, next) => {
    try {
      const { parentPath, name } = req.body ?? {};
      if (!parentPath || typeof parentPath !== "string" || !name || typeof name !== "string") {
        throw new AppError(400, ErrorCodes.INVALID_INPUT, "parentPath and name are required");
      }
      const trimmedName = name.trim();
      if (!trimmedName || trimmedName === "." || trimmedName === "..") {
        throw new AppError(400, ErrorCodes.INVALID_INPUT, "Invalid folder name");
      }
      if (trimmedName.includes("/") || trimmedName.includes("\\")) {
        throw new AppError(400, ErrorCodes.INVALID_INPUT, "Folder name cannot contain path separators");
      }

      const parentResolved = resolve(parentPath);
      const newPath = join(parentResolved, trimmedName);
      if (!newPath.startsWith(parentResolved)) {
        throw new AppError(400, ErrorCodes.INVALID_INPUT, "Invalid path");
      }
      if (!isPathUnderRoot(parentResolved) || !isPathUnderRoot(newPath)) {
        throw new AppError(400, ErrorCodes.INVALID_INPUT, "Path is outside the allowed directory.");
      }

      if (!existsSync(parentResolved)) {
        throw new AppError(404, ErrorCodes.NOT_FOUND, "Parent directory does not exist");
      }
      const parentStat = await stat(parentResolved);
      if (!parentStat.isDirectory()) {
        throw new AppError(400, ErrorCodes.NOT_DIRECTORY, "Parent path is not a directory");
      }

      if (existsSync(newPath)) {
        throw new AppError(409, ErrorCodes.ALREADY_EXISTS, "A file or folder with that name already exists");
      }

      await mkdir(newPath, { recursive: false });
      const body: ApiResponse<{ path: string }> = { data: { path: newPath } };
      res.json(body);
    } catch (err) {
      next(err);
    }
  }
);

// GET /fs/detect-test-framework?path=/some/path — Detect test framework from project files
fsRouter.get(
  "/detect-test-framework",
  async (req: Request<object, object, object, { path?: string }>, res, next) => {
    try {
      const rawPath = req.query.path?.trim();
      if (!rawPath) {
        throw new AppError(400, ErrorCodes.INVALID_INPUT, "Path query parameter is required");
      }

      const targetPath = resolve(rawPath);
      if (!isPathUnderRoot(targetPath)) {
        throw new AppError(400, ErrorCodes.INVALID_INPUT, "Path is outside the allowed directory.");
      }
      if (!existsSync(targetPath)) {
        throw new AppError(404, ErrorCodes.NOT_FOUND, "Directory does not exist");
      }

      const detected = await detectTestFramework(targetPath);
      const body: ApiResponse<{ framework: string; testCommand: string } | null> = {
        data: detected,
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  }
);
