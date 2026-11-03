import path from "path";
import { realpathSync } from "fs";
import type { FsBrowsePolicyRuntimeInfo } from "@opensprint/shared";

/** Used only when home-directory browsing is effectively enabled. */
export function resolveUserHomeDirectory(): string {
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

function isHomeBrowseEnvToken(): boolean {
  const v = process.env.OPENSPRINT_ALLOW_HOME_BROWSE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function isCiLike(): boolean {
  const c = process.env.CI?.trim().toLowerCase();
  return c === "1" || c === "true";
}

/** Escape hatch when home-wide browse is genuinely required under CI (discouraged). */
function isAllowHomeBrowseInCi(): boolean {
  const v = process.env.OPENSPRINT_ALLOW_HOME_BROWSE_IN_CI?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Desktop folder pickers start in the user home by default. Server deployments require
 * `OPENSPRINT_ALLOW_HOME_BROWSE` to expand beyond cwd; an explicit false value also opts
 * desktop out. `OPENSPRINT_FS_ROOT` still takes precedence over either default.
 * In CI (`CI=true`), this is ignored unless `OPENSPRINT_ALLOW_HOME_BROWSE_IN_CI` is also set,
 * so non-interactive automation does not accidentally expose the entire home directory.
 */
export function isHomeBrowseEffective(): boolean {
  const desktopDefault =
    process.env.OPENSPRINT_DESKTOP === "1" && !process.env.OPENSPRINT_ALLOW_HOME_BROWSE?.trim();
  if (!isHomeBrowseEnvToken() && !desktopDefault) return false;
  if (isCiLike() && !isAllowHomeBrowseInCi()) return false;
  return true;
}

export function isFsRootConfigured(): boolean {
  return Boolean(process.env.OPENSPRINT_FS_ROOT?.trim());
}

export function realpathOrNormalized(absPath: string): string {
  try {
    return realpathSync(absPath);
  } catch {
    return path.normalize(absPath);
  }
}

/**
 * Configured allowed tree for FS API routes before realpath canonicalization.
 * `OPENSPRINT_FS_ROOT` wins when set; else home for desktop or explicit opt-in; else cwd.
 */
export function getLogicalFsAllowedRoot(): string {
  const configuredRoot = process.env.OPENSPRINT_FS_ROOT?.trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }
  if (isHomeBrowseEffective()) {
    return resolveUserHomeDirectory();
  }
  return path.resolve(process.cwd());
}

/** Resolved allowed root boundary (realpath when the path exists). */
export function getResolvedFsAllowedRoot(): string {
  return realpathOrNormalized(getLogicalFsAllowedRoot());
}

export function isPathUnderAllowedRoot(candidateAbsPath: string): boolean {
  const allowedRoot = getResolvedFsAllowedRoot();
  const resolvedCandidate = path.resolve(candidateAbsPath);
  const normalized = realpathOrNormalized(resolvedCandidate);
  const relative = path.relative(allowedRoot, normalized);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function getFsBrowsePolicyRuntimeInfo(): FsBrowsePolicyRuntimeInfo {
  const fsRootConfigured = isFsRootConfigured();
  const homeBrowseEnvRequested = isHomeBrowseEnvToken();
  const ci = isCiLike();
  const homeBrowseSuppressedByCi = homeBrowseEnvRequested && ci && !isAllowHomeBrowseInCi();
  const homeBrowseWouldApply = isHomeBrowseEffective();
  const homeBrowseEffective = homeBrowseWouldApply && !fsRootConfigured;

  let adminWarning: string | null = null;
  if (fsRootConfigured) {
    adminWarning =
      "OPENSPRINT_FS_ROOT limits the filesystem browse API; every path is checked against the resolved real path of that root. Point it at a directory attackers cannot retarget with symlinks outside the intended tree.";
    if (homeBrowseWouldApply) {
      adminWarning +=
        " OPENSPRINT_ALLOW_HOME_BROWSE does not widen the tree beyond this root while OPENSPRINT_FS_ROOT is set.";
    }
  } else if (homeBrowseSuppressedByCi) {
    adminWarning =
      "OPENSPRINT_ALLOW_HOME_BROWSE is set but ignored while CI=true. Home-wide filesystem browse is disabled in CI unless you also set OPENSPRINT_ALLOW_HOME_BROWSE_IN_CI=1 (avoid unless required).";
  } else if (homeBrowseEffective && homeBrowseEnvRequested) {
    adminWarning =
      "The filesystem browse API can reach your entire user home directory (OPENSPRINT_ALLOW_HOME_BROWSE). Use only on trusted hosts. Unset the variable or set OPENSPRINT_FS_ROOT to cap exposure.";
  }

  return {
    homeBrowseEnvRequested,
    homeBrowseEffective,
    homeBrowseSuppressedByCi,
    fsRootConfigured,
    adminWarning,
  };
}
