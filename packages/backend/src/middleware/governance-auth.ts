import { timingSafeEqual, createHash } from "crypto";
import type { Request, RequestHandler } from "express";
import { AppError } from "./error-handler.js";

export const GOVERNANCE_CAPABILITY_HEADER = "x-opensprint-governance-capability";
export function governanceAuthorityConfigured(): boolean {
  return Boolean(
    (process.env.OPENSPRINT_GOVERNANCE_APPROVAL_SECRET?.length ?? 0) >= 32 &&
    process.env.OPENSPRINT_GOVERNANCE_OWNER?.trim()
  );
}
export function getGovernanceActor(_req: Request): string {
  return process.env.OPENSPRINT_GOVERNANCE_OWNER?.trim() ?? "";
}
/** A separate approval capability, never the local session bearer credential. */
export function authorizedGovernanceActor(req: Request): string {
  const expected = process.env.OPENSPRINT_GOVERNANCE_APPROVAL_SECRET ?? "";
  const supplied = req.get(GOVERNANCE_CAPABILITY_HEADER) ?? "";
  if (!governanceAuthorityConfigured())
    throw new AppError(
      403,
      "GOVERNANCE_HUMAN_REQUIRED",
      "Governance approval is not configured on this server. Set a separate owner and approval secret, then retry.",
      { reason: "not_configured" }
    );
  if (!supplied)
    throw new AppError(
      403,
      "GOVERNANCE_HUMAN_REQUIRED",
      "An authorized human approval capability is required. Enter the owner's approval capability.",
      { reason: "missing" }
    );
  if (
    !timingSafeEqual(
      createHash("sha256").update(expected).digest(),
      createHash("sha256").update(supplied).digest()
    )
  )
    throw new AppError(
      403,
      "GOVERNANCE_HUMAN_REQUIRED",
      "That approval capability is incorrect. Check it and try again.",
      { reason: "incorrect" }
    );
  return getGovernanceActor(req);
}
export const requireGovernanceHuman: RequestHandler = (req, _res, next) => {
  try {
    authorizedGovernanceActor(req);
    next();
  } catch (error) {
    next(error);
  }
};
export function withoutGovernanceCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  delete result.OPENSPRINT_GOVERNANCE_APPROVAL_SECRET;
  delete result.OPENSPRINT_GOVERNANCE_OWNER;
  return result;
}
