import { describe, it, expect, vi, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  requireGovernanceHuman,
  getGovernanceActor,
  governanceAuthorityConfigured,
  withoutGovernanceCredentials,
} from "../middleware/governance-auth.js";
function authorize(capability: string) {
  const next = vi.fn();
  requireGovernanceHuman(
    {
      get: () => capability,
      body: { actor: "agent-pretending-to-be-owner" },
    } as unknown as Request,
    {} as Response,
    next as NextFunction
  );
  return next;
}
afterEach(() => vi.unstubAllEnvs());
describe("separate human governance capability", () => {
  it("does not authorize a local bearer secret or an asserted human identity", () => {
    vi.stubEnv("OPENSPRINT_GOVERNANCE_APPROVAL_SECRET", "human-secret-".repeat(4));
    vi.stubEnv("OPENSPRINT_GOVERNANCE_OWNER", "Todd");
    const next = authorize("ordinary-local-session-bearer");
    expect(next.mock.calls[0][0]).toMatchObject({
      statusCode: 403,
      code: "GOVERNANCE_HUMAN_REQUIRED",
    });
  });
  it("requires explicitly configured owner and a sufficiently strong independent secret", () => {
    vi.stubEnv("OPENSPRINT_GOVERNANCE_APPROVAL_SECRET", "short");
    vi.stubEnv("OPENSPRINT_GOVERNANCE_OWNER", "Todd");
    expect(governanceAuthorityConfigured()).toBe(false);
    expect(authorize("short").mock.calls[0][0]).toMatchObject({ statusCode: 403 });
    vi.stubEnv("OPENSPRINT_GOVERNANCE_APPROVAL_SECRET", "human-secret-".repeat(4));
    vi.stubEnv("OPENSPRINT_GOVERNANCE_OWNER", "");
    expect(governanceAuthorityConfigured()).toBe(false);
  });
  it("accepts the capability and assigns the server configured authority", () => {
    const secret = "human-secret-".repeat(4);
    vi.stubEnv("OPENSPRINT_GOVERNANCE_APPROVAL_SECRET", secret);
    vi.stubEnv("OPENSPRINT_GOVERNANCE_OWNER", "Todd");
    expect(authorize(secret).mock.calls[0]).toEqual([]);
    expect(getGovernanceActor({ body: { actor: "agent" } } as Request)).toBe("Todd");
  });
  it("removes approval credentials from inherited subprocess environments", () => {
    const original = {
      OPENSPRINT_GOVERNANCE_APPROVAL_SECRET: "human",
      OPENSPRINT_GOVERNANCE_OWNER: "Todd",
      OPENAI_API_KEY: "task-model-key",
      PATH: "/bin",
    };
    expect(withoutGovernanceCredentials(original)).toEqual({
      OPENAI_API_KEY: "task-model-key",
      PATH: "/bin",
    });
    expect(original.OPENSPRINT_GOVERNANCE_APPROVAL_SECRET).toBe("human");
  });
});
