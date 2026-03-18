import { Router, Request } from "express";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import {
  fsBrowseQuerySchema,
  fsCreateFolderBodySchema,
  fsDetectTestFrameworkQuerySchema,
} from "../schemas/request-fs.js";
import { readdir, stat, mkdir } from "fs/promises";
import path from "path";
import { join, resolve, dirname } from "path";
import { existsSync } from "fs";
import type { ApiResponse } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { detectTestFramework } from "../services/test-framework.service.js";

function getDefaultBrowseRoot(): string {
  if (process.platform === "win32") {
    const windowsHome =
      process.env.USERPROFILE?.trim() ||
      `${process.env.HOMEDRIVE ?? ""}${process.env.HOMEPATH ?? ""}`.trim() ||
      process.env.HOME?.trim();
    if (windowsHome) {
      return path.resolve(windowsHome);
    }
  }

  const homeDir = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  if (homeDir) {
    return path.resolve(homeDir);
  }

  return path.resolve(process.cwd());
}

function getFsAllowedRoot(): string {
  const configuredRoot = process.env.OPENSPRINT_FS_ROOT?.trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }

  return getDefaultBrowseRoot();
}

function isPathUnderRoot(resolvedPath: string): boolean {
  const allowedRoot = getFsAllowedRoot();
  const normalized = path.normalize(resolvedPath);
  const relative = path.relative(allowedRoot, normalized);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** When OPENSPRINT_FS_ROOT is set, enforce path restriction for locked-down deployments. */
function shouldEnforcePathRestriction(): boolean {
  return !!process.env.OPENSPRINT_FS_ROOT?.trim();
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
  validateQuery(fsBrowseQuerySchema),
  wrapAsync(async (req: Request<object, object, object, { path?: string }>, res) => {
    const rawPath = (req.query as { path?: string }).path;
    const targetPath = rawPath?.trim() ? resolve(rawPath) : getDefaultBrowseRoot();

    if (shouldEnforcePathRestriction() && !isPathUnderRoot(targetPath)) {
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
  })
);

interface CreateFolderBody {
  parentPath: string;
  name: string;
}

// POST /fs/create-folder — Create a new folder and return its path
fsRouter.post(
  "/create-folder",
  validateBody(fsCreateFolderBodySchema),
  wrapAsync(async (req: Request<object, object, CreateFolderBody>, res) => {
    const { parentPath, name } = req.body;
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName === "." || trimmedName === "..") {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Invalid folder name");
    }
    if (trimmedName.includes("/") || trimmedName.includes("\\")) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        "Folder name cannot contain path separators"
      );
    }

    const parentResolved = resolve(parentPath);
    const newPath = join(parentResolved, trimmedName);
    if (!newPath.startsWith(parentResolved)) {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Invalid path");
    }
    if (
      shouldEnforcePathRestriction() &&
      (!isPathUnderRoot(parentResolved) || !isPathUnderRoot(newPath))
    ) {
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
      throw new AppError(
        409,
        ErrorCodes.ALREADY_EXISTS,
        "A file or folder with that name already exists"
      );
    }

    await mkdir(newPath, { recursive: false });
    const body: ApiResponse<{ path: string }> = { data: { path: newPath } };
    res.json(body);
  })
);

// GET /fs/detect-test-framework?path=/some/path — Detect test framework from project files
fsRouter.get(
  "/detect-test-framework",
  validateQuery(fsDetectTestFrameworkQuerySchema),
  wrapAsync(async (req: Request<object, object, object, { path?: string }>, res) => {
    const rawPath = (req.query as { path: string }).path.trim();

    const targetPath = resolve(rawPath);
    if (shouldEnforcePathRestriction() && !isPathUnderRoot(targetPath)) {
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
  })
);
