import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, ApiError, isApiError, isConnectionError, request } from "./client";
import { setAccessSession } from "./session";

describe("api client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("request handling", () => {
    it("retains a request identity after a lost response and attaches the cookie CSRF token", async () => {
      setAccessSession({
        principal: {
          actorId: "alice",
          displayName: "Alice",
          local: false,
          role: "participant",
          permissions: ["read", "edit"],
        },
        csrfToken: "csrf",
      });
      vi.mocked(fetch)
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce({ ok: true, status: 204 } as Response);
      const input = { method: "POST", body: JSON.stringify({ text: "One instruction" }) };
      await expect(request("/projects/p/chat", input)).rejects.toThrow("Failed to fetch");
      await request("/projects/p/chat", input);
      const first = vi.mocked(fetch).mock.calls[0]![1]!;
      const second = vi.mocked(fetch).mock.calls[1]![1]!;
      expect(first.credentials).toBe("same-origin");
      expect(new Headers(first.headers).get("X-OpenSprint-CSRF")).toBe("csrf");
      expect(new Headers(second.headers).get("Idempotency-Key")).toBe(
        new Headers(first.headers).get("Idempotency-Key")
      );
      setAccessSession(undefined);
    });
    it("returns data from successful JSON response", async () => {
      const mockData = [{ id: "proj-1", name: "Test" }];
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: mockData }),
      } as Response);

      const result = await api.projects.list();
      expect(result).toEqual(mockData);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/projects"),
        expect.objectContaining({ headers: expect.any(Object) })
      );
    });

    it("passes an AbortSignal to fetch so requests use the default timeout", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: [] }),
      } as Response);

      await api.projects.list();
      const [, init] = vi.mocked(fetch).mock.calls[0]!;
      expect(init).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it("returns undefined for 204 No Content", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 204,
      } as Response);

      const result = await api.projects.delete("proj-1");
      expect(result).toBeUndefined();
    });

    it("throws ApiError with message and code when response not ok", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: vi.fn().mockResolvedValue({
          error: { code: "VALIDATION", message: "Invalid project ID" },
        }),
      } as Response);

      await expect(api.projects.get("invalid")).rejects.toThrow("Invalid project ID");
      const err = await api.projects.get("invalid").catch((e) => e);
      expect(isApiError(err)).toBe(true);
      expect((err as ApiError).code).toBe("VALIDATION");
      expect((err as ApiError).message).toBe("Invalid project ID");
    });

    it("uses error.details when present (scaffold recovery)", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: vi.fn().mockResolvedValue({
          error: {
            code: "SCAFFOLD_INIT_FAILED",
            message: "Node.js is not installed",
            details: { repoPath: "/tmp/proj", recovery: { attempted: true, success: false } },
          },
        }),
      } as Response);

      const err = await api.projects
        .scaffold({ name: "x", parentPath: "/tmp", template: "react" })
        .catch((e) => e);
      expect(isApiError(err)).toBe(true);
      const details = (err as ApiError).details as {
        repoPath?: string;
        recovery?: { attempted: boolean };
      };
      expect(details?.recovery?.attempted).toBe(true);
    });

    it("uses full error when details absent (Expo prompt at top level)", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: vi.fn().mockResolvedValue({
          error: {
            code: "EXPO_TOKEN_REQUIRED",
            message: "Auth required",
            prompt: "Go to expo.dev",
          },
        }),
      } as Response);

      const err = await api.deliver.expoDeploy("proj-1", "beta").catch((e) => e);
      expect(isApiError(err)).toBe(true);
      const details = (err as ApiError).details as { prompt?: string };
      expect(details?.prompt).toBe("Go to expo.dev");
    });

    it("throws with statusText when error JSON has no message", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: vi.fn().mockResolvedValue({}),
      } as Response);

      await expect(api.projects.list()).rejects.toThrow("Internal Server Error");
    });

    it("uses statusText when JSON parse fails for error response", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Server Error",
        json: vi.fn().mockRejectedValue(new Error("Parse error")),
      } as Response);

      await expect(api.projects.list()).rejects.toThrow("Server Error");
      const err = await api.projects.list().catch((e) => e);
      expect(isApiError(err)).toBe(true);
      expect((err as ApiError).code).toBe("UNKNOWN");
    });
  });

  describe("deliver", () => {
    it("expoReadiness calls GET /projects/:projectId/deliver/expo-readiness and returns readiness", async () => {
      const readiness = {
        expoInstalled: true,
        expoConfigured: true,
        authOk: true,
        easProjectLinked: true,
        missing: [] as string[],
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: readiness }),
      } as Response);

      const result = await api.deliver.expoReadiness("proj-1");
      expect(result).toEqual(readiness);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/projects/proj-1/deliver/expo-readiness"),
        expect.any(Object)
      );
    });

    it("expoReadiness returns missing and prompt when auth not ok", async () => {
      const readiness = {
        expoInstalled: true,
        expoConfigured: true,
        authOk: false,
        easProjectLinked: false,
        missing: ["auth", "easProjectLinked"],
        prompt: "Add your Expo token in Settings.",
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: readiness }),
      } as Response);

      const result = await api.deliver.expoReadiness("proj-1");
      expect(result.authOk).toBe(false);
      expect(result.missing).toEqual(["auth", "easProjectLinked"]);
      expect(result.prompt).toBe("Add your Expo token in Settings.");
    });
  });

  describe("projects", () => {
    it("get calls correct endpoint", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { id: "proj-1", name: "Test" } }),
      } as Response);

      await api.projects.get("proj-1");
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/projects/proj-1"),
        expect.any(Object)
      );
    });

    it("create sends POST with body", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { id: "proj-1", name: "New" } }),
      } as Response);

      await api.projects.create({ name: "New Project" });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/projects"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "New Project" }),
        })
      );
    });

    it("getSettings returns project settings without apiKeys (global-only)", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: {
            simpleComplexityAgent: { type: "cursor", model: "composer-1.5", cliCommand: null },
            complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
            deployment: { mode: "custom" },
            hilConfig: {},
            testFramework: "vitest",
          },
        }),
      } as Response);

      const result = await api.projects.getSettings("proj-1");
      expect(result).not.toHaveProperty("apiKeys");
      expect(result.simpleComplexityAgent).toBeDefined();
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/projects/proj-1/settings"),
        expect.any(Object)
      );
    });

    it("updateSettings does not send apiKeys (use global settings)", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: {
            simpleComplexityAgent: { type: "cursor", model: "composer-1.5", cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: "composer-1.5", cliCommand: null },
            deployment: { mode: "custom" },
            hilConfig: {},
            testFramework: "vitest",
          },
        }),
      } as Response);

      await api.projects.updateSettings("proj-1", {
        simpleComplexityAgent: { type: "cursor", model: "composer-1.5", cliCommand: null },
        complexComplexityAgent: { type: "cursor", model: "composer-1.5", cliCommand: null },
      });
      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body).not.toHaveProperty("apiKeys");
    });
  });

  describe("chat", () => {
    it("send includes context and prdSectionFocus in body", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { message: "Hi" } }),
      } as Response);

      await api.chat.send("proj-1", "Hello", "sketch", "overview");
      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body.message).toBe("Hello");
      expect(body.context).toBe("sketch");
      expect(body.prdSectionFocus).toBe("overview");
    });

    it("send includes images in body when provided", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { message: "Hi" } }),
      } as Response);

      const images = ["data:image/png;base64,abc"];
      await api.chat.send("proj-1", "Describe this", "sketch", undefined, images);
      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body.message).toBe("Describe this");
      expect(body.images).toEqual(images);
    });

    it("send does not apply the default client timeout to agent-backed chat requests", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { message: "Hi" } }),
      } as Response);

      await api.chat.send("proj-1", "Hello", "sketch");
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call?.[1]).not.toHaveProperty("signal");
    });

    it("send still allows callers to opt back into a client timeout", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { message: "Hi" } }),
      } as Response);

      await api.chat.send("proj-1", "Hello", "sketch", undefined, undefined, undefined, {
        timeoutMs: 5_000,
      });
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call?.[1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it("history encodes context in URL for plan chat", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: { id: "conv-1", context: "plan:auth-plan", messages: [] },
        }),
      } as Response);

      await api.chat.history("proj-1", "plan:auth-plan");
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("context=plan%3Aauth-plan"),
        expect.any(Object)
      );
    });
  });

  describe("plans", () => {
    it("list calls GET /projects/:projectId/plans and returns plans with edges", async () => {
      const mockGraph = {
        plans: [
          {
            metadata: {
              planId: "p1",
              epicId: "e1",
              shippedAt: null,
              complexity: "medium",
              parentPlanId: "parent-p1",
              depth: 2,
            },
            content: "# Plan",
            status: "in_review",
            taskCount: 2,
            doneTaskCount: 2,
            dependencyCount: 0,
            depth: 1,
            childPlanIds: ["child-a", "child-b"],
          },
        ],
        edges: [],
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: mockGraph }),
      } as Response);

      const result = await api.plans.list("proj-1");
      expect(result).toEqual(mockGraph);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/projects/proj-1/plans"),
        expect.any(Object)
      );
    });

    it("get calls GET /projects/:projectId/plans/:planId and returns plan including hierarchy fields", async () => {
      const plan = {
        metadata: {
          planId: "p1",
          epicId: "e1",
          shippedAt: null,
          complexity: "medium" as const,
          parentPlanId: "root-1",
          depth: 2,
        },
        content: "# Plan",
        status: "planning" as const,
        taskCount: 0,
        doneTaskCount: 0,
        dependencyCount: 0,
        depth: 1,
        childPlanIds: ["c1"],
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: plan }),
      } as Response);

      const result = await api.plans.get("proj-1", "p1");
      expect(result).toEqual(plan);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/projects/proj-1/plans/p1"),
        expect.any(Object)
      );
    });

    it("getHierarchy calls GET /projects/:projectId/plans/:planId/hierarchy", async () => {
      const hierarchy = {
        root: {
          planId: "p1",
          epicId: "e1",
          depth: 1,
          status: "planning" as const,
          taskCount: 0,
          children: [
            {
              planId: "c1",
              epicId: "e2",
              parentPlanId: "p1",
              depth: 2,
              status: "planning" as const,
              taskCount: 0,
              children: [],
            },
          ],
        },
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: hierarchy }),
      } as Response);

      const result = await api.plans.getHierarchy("proj-1", "p1");
      expect(result).toEqual(hierarchy);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/projects/proj-1/plans/p1/hierarchy"),
        expect.any(Object)
      );
    });

    it("markPlanComplete calls POST /projects/:projectId/plans/:planId/mark-complete and returns plan", async () => {
      const updatedPlan = {
        metadata: {
          planId: "p1",
          epicId: "e1",
          shippedAt: null,
          reviewedAt: "2025-03-09T12:00:00.000Z",
          complexity: "medium",
        },
        content: "# Plan",
        status: "complete",
        taskCount: 2,
        doneTaskCount: 2,
        dependencyCount: 0,
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: updatedPlan }),
      } as Response);

      const result = await api.plans.markPlanComplete("proj-1", "p1");
      expect(result).toEqual(updatedPlan);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/projects/proj-1/plans/p1/mark-complete"),
        expect.objectContaining({ method: "POST" })
      );
    });

    it("listVersions calls GET /projects/:projectId/plans/:planId/versions and returns versions array", async () => {
      const versions = [
        {
          id: "v1",
          version_number: 1,
          created_at: "2025-01-01T00:00:00Z",
          is_executed_version: true,
        },
        { id: "v2", version_number: 2, created_at: "2025-01-02T00:00:00Z" },
      ];
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { versions } }),
      } as Response);

      const result = await api.plans.listVersions("proj-1", "plan-abc");
      expect(result).toEqual(versions);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/projects/proj-1/plans/plan-abc/versions"),
        expect.any(Object)
      );
    });

    it("getVersion calls GET /projects/:projectId/plans/:planId/versions/:versionNumber and returns version content", async () => {
      const content = {
        version_number: 3,
        title: "My Plan",
        content: "# Plan v3\n\nBody",
        created_at: "2025-01-03T00:00:00Z",
        is_executed_version: false,
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: content }),
      } as Response);

      const result = await api.plans.getVersion("proj-1", "plan-abc", 3);
      expect(result).toEqual(content);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/projects/proj-1/plans/plan-abc/versions/3"),
        expect.any(Object)
      );
    });

    it("execute sends POST with optional version_number in body", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: {} }),
      } as Response);

      await api.plans.execute("proj-1", "plan-1", { version_number: 7 });
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toContain("/projects/proj-1/plans/plan-1/execute");
      const body = JSON.parse(call[1]?.body as string);
      expect(body).toEqual({ version_number: 7 });
    });

    it("execute sends POST with prerequisitePlanIds and version_number when both provided", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: {} }),
      } as Response);

      await api.plans.execute("proj-1", "plan-2", {
        prerequisitePlanIds: ["plan-a", "plan-b"],
        version_number: 2,
      });
      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body).toEqual({
        prerequisitePlanIds: ["plan-a", "plan-b"],
        version_number: 2,
      });
    });

    it("execute sends POST with no body when no options provided", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: {} }),
      } as Response);

      await api.plans.execute("proj-1", "plan-1");
      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body).toEqual({});
    });
  });

  describe("help", () => {
    it("chat does not apply the default client timeout", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { message: "Hi" } }),
      } as Response);

      await api.help.chat({ message: "What is running?" });
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call?.[1]).not.toHaveProperty("signal");
    });
  });

  describe("prd", () => {
    it("generateFromCodebase does not apply the default client timeout", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 204,
      } as Response);

      await api.prd.generateFromCodebase("proj-1");
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call?.[1]).not.toHaveProperty("signal");
    });
  });

  describe("models", () => {
    it("list calls correct endpoint with provider", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: [{ id: "claude-3-5-sonnet", displayName: "Claude 3.5 Sonnet" }],
        }),
      } as Response);

      const result = await api.models.list("claude");
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ id: "claude-3-5-sonnet", displayName: "Claude 3.5 Sonnet" });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/models?provider=claude"),
        expect.any(Object)
      );
    });

    it("list appends baseUrl when provider is lmstudio and baseUrl provided", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: [{ id: "local-model", displayName: "Local Model" }],
        }),
      } as Response);

      await api.models.list("lmstudio", "proj-1", "http://localhost:1234");
      const url = vi.mocked(fetch).mock.calls[0][0];
      expect(url).toContain("/api/v1/models");
      expect(url).toContain("provider=lmstudio");
      expect(url).toContain("projectId=proj-1");
      expect(url).toContain("baseUrl=" + encodeURIComponent("http://localhost:1234"));
    });

    it("list does not append baseUrl when provider is not lmstudio", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: [] }),
      } as Response);

      await api.models.list("openai", "proj-1", "http://localhost:1234");
      const url = vi.mocked(fetch).mock.calls[0][0];
      expect(url).not.toContain("baseUrl=");
    });
  });

  describe("env", () => {
    it("getKeys returns anthropic, cursor, openai, claudeCli, cursorCli, useCustomCli", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: {
            anthropic: true,
            cursor: false,
            openai: true,
            claudeCli: true,
            cursorCli: false,
            useCustomCli: false,
          },
        }),
      } as Response);

      const result = await api.env.getKeys();
      expect(result).toEqual({
        anthropic: true,
        cursor: false,
        openai: true,
        claudeCli: true,
        cursorCli: false,
        useCustomCli: false,
      });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/env/keys"),
        expect.any(Object)
      );
    });

    it("getGlobalStatus returns hasAnyKey and useCustomCli", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: { hasAnyKey: true, useCustomCli: false },
        }),
      } as Response);

      const result = await api.env.getGlobalStatus();
      expect(result).toEqual({ hasAnyKey: true, useCustomCli: false });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/env/global-status"),
        expect.any(Object)
      );
    });

    it("setGlobalSettings sends PUT with useCustomCli", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: { useCustomCli: true },
        }),
      } as Response);

      const result = await api.env.setGlobalSettings({ useCustomCli: true });
      expect(result).toEqual({ useCustomCli: true });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/env/global-settings"),
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ useCustomCli: true }),
        })
      );
    });

    it("validateKey sends POST with provider and value", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { valid: true } }),
      } as Response);

      const result = await api.env.validateKey("claude", "sk-secret");
      expect(result).toEqual({ valid: true });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/env/keys/validate"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ provider: "claude", value: "sk-secret" }),
        })
      );
    });

    it("validateKey returns valid: false with error on failure", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: { valid: false, error: "Invalid API key" },
        }),
      } as Response);

      const result = await api.env.validateKey("cursor", "bad-key");
      expect(result).toEqual({ valid: false, error: "Invalid API key" });
    });

    it("saveKey sends POST with key and value", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { saved: true } }),
      } as Response);

      await api.env.saveKey("ANTHROPIC_API_KEY", "sk-secret");
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/env/keys"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ key: "ANTHROPIC_API_KEY", value: "sk-secret" }),
        })
      );
    });

    it("validateKey accepts openai provider", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { valid: true } }),
      } as Response);

      const result = await api.env.validateKey("openai", "sk-openai-key");
      expect(result).toEqual({ valid: true });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/env/keys/validate"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ provider: "openai", value: "sk-openai-key" }),
        })
      );
    });

    it("saveKey accepts OPENAI_API_KEY", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { saved: true } }),
      } as Response);

      await api.env.saveKey("OPENAI_API_KEY", "sk-openai-key");
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/env/keys"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ key: "OPENAI_API_KEY", value: "sk-openai-key" }),
        })
      );
    });
  });

  describe("notifications", () => {
    it("retryRateLimit posts to retry-rate-limit and returns ok", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { ok: true, resolvedCount: 1 } }),
      } as Response);

      const result = await api.notifications.retryRateLimit("proj-1", "ab-123");
      expect(result).toEqual({ ok: true, resolvedCount: 1 });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/projects/proj-1/notifications/ab-123/retry-rate-limit"),
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  describe("globalSettings", () => {
    it("get returns databaseUrl", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: { databaseUrl: "postgresql://user:***@localhost:5432/opensprint" },
        }),
      } as Response);

      const result = await api.globalSettings.get();
      expect(result).toEqual({ databaseUrl: "postgresql://user:***@localhost:5432/opensprint" });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/global-settings"),
        expect.any(Object)
      );
    });

    it("get returns apiKeys (masked) when present", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: {
            databaseUrl: "postgresql://user:***@localhost:5432/opensprint",
            apiKeys: {
              ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
              CURSOR_API_KEY: [
                { id: "k2", masked: "••••••••", limitHitAt: "2025-01-01T00:00:00Z" },
              ],
            },
          },
        }),
      } as Response);

      const result = await api.globalSettings.get();
      expect(result.databaseUrl).toBe("postgresql://user:***@localhost:5432/opensprint");
      expect(result.apiKeys).toEqual({
        ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
        CURSOR_API_KEY: [{ id: "k2", masked: "••••••••", limitHitAt: "2025-01-01T00:00:00Z" }],
      });
    });

    it("put sends databaseUrl and returns masked", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: { databaseUrl: "postgresql://user:***@db.example.com:5432/opensprint" },
        }),
      } as Response);

      const result = await api.globalSettings.put({
        databaseUrl: "postgresql://user:secret@db.example.com:5432/opensprint",
      });
      expect(result).toEqual({
        databaseUrl: "postgresql://user:***@db.example.com:5432/opensprint",
      });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/global-settings"),
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            databaseUrl: "postgresql://user:secret@db.example.com:5432/opensprint",
          }),
        })
      );
    });

    it("put accepts apiKeys and sends them in body", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: {
            databaseUrl: "postgresql://user:***@localhost:5432/opensprint",
            apiKeys: {
              ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
            },
          },
        }),
      } as Response);

      const result = await api.globalSettings.put({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-secret" }],
        },
      });
      expect(result.apiKeys).toEqual({
        ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
      });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/global-settings"),
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            apiKeys: {
              ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-secret" }],
            },
          }),
        })
      );
    });

    it("revealKey fetches raw value for provider and id", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: { value: "sk-ant-revealed-secret" },
        }),
      } as Response);

      const result = await api.globalSettings.revealKey("ANTHROPIC_API_KEY", "k1");
      expect(result).toEqual({ value: "sk-ant-revealed-secret" });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/global-settings/reveal-key/ANTHROPIC_API_KEY/k1"),
        expect.any(Object)
      );
    });

    it("clearLimitHit posts to clear-limit-hit and returns updated settings", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: {
            databaseUrl: "postgresql://user:***@localhost:5432/opensprint",
            apiKeys: {
              ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
            },
          },
        }),
      } as Response);

      const result = await api.globalSettings.clearLimitHit("ANTHROPIC_API_KEY", "k1");
      expect(result.apiKeys).toEqual({
        ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
      });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/global-settings/clear-limit-hit/ANTHROPIC_API_KEY/k1"),
        expect.objectContaining({ method: "POST" })
      );
    });

    it("setupTables posts databaseUrl and returns ok", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { ok: true } }),
      } as Response);

      const result = await api.globalSettings.setupTables(
        "postgresql://user:secret@localhost:5432/opensprint"
      );
      expect(result).toEqual({ ok: true });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/global-settings/setup-tables"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            databaseUrl: "postgresql://user:secret@localhost:5432/opensprint",
          }),
        })
      );
    });
  });

  describe("isConnectionError", () => {
    it("returns false for ApiError (server responded)", () => {
      expect(isConnectionError(new ApiError("Not found", "PROJECT_NOT_FOUND"))).toBe(false);
    });

    it("returns true for Failed to fetch", () => {
      expect(isConnectionError(new TypeError("Failed to fetch"))).toBe(true);
      expect(isConnectionError({ message: "Failed to fetch" })).toBe(true);
    });

    it("returns true for NetworkError", () => {
      expect(isConnectionError(new Error("NetworkError"))).toBe(true);
      expect(isConnectionError({ message: "NetworkError" })).toBe(true);
    });

    it("returns true for Network request failed", () => {
      expect(isConnectionError(new Error("Network request failed"))).toBe(true);
    });

    it("returns true for Load failed", () => {
      expect(isConnectionError(new Error("Load failed"))).toBe(true);
      expect(isConnectionError(new Error("Load failed: something"))).toBe(true);
    });

    it("returns false for other errors", () => {
      expect(isConnectionError(new Error("Something else"))).toBe(false);
      expect(isConnectionError(new ApiError("Bad request", "VALIDATION"))).toBe(false);
    });
  });

  describe("tasks.openEditor", () => {
    it("calls POST /projects/:projectId/tasks/:taskId/open-editor and returns result", async () => {
      const mockResult = {
        worktreePath: "/tmp/worktrees/os-1234",
        editor: "cursor" as const,
        opened: true,
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: mockResult }),
      } as Response);

      const result = await api.tasks.openEditor("proj-1", "os-1234");
      expect(result).toEqual(mockResult);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/projects/proj-1/tasks/os-1234/open-editor"),
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  describe("tasks.chatHistory", () => {
    it("calls GET /projects/:projectId/tasks/:taskId/chat-history without attempt", async () => {
      const mockResult = {
        messages: [
          {
            id: "msg-1",
            timestamp: "2025-01-01T00:00:00Z",
            role: "user" as const,
            content: "Hello",
            attempt: 1,
          },
        ],
        attempt: 1,
        chatSupported: true,
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: mockResult }),
      } as Response);

      const result = await api.tasks.chatHistory("proj-1", "os-1234");
      expect(result).toEqual(mockResult);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/projects/proj-1/tasks/os-1234/chat-history"),
        expect.any(Object)
      );
      const url = vi.mocked(fetch).mock.calls[0][0] as string;
      expect(url).not.toContain("attempt=");
    });

    it("includes attempt query param when provided", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi
          .fn()
          .mockResolvedValue({ data: { messages: [], attempt: 2, chatSupported: false } }),
      } as Response);

      await api.tasks.chatHistory("proj-1", "os-1234", 2);
      const url = vi.mocked(fetch).mock.calls[0][0] as string;
      expect(url).toContain("attempt=2");
    });
  });

  describe("tasks.chatSupport", () => {
    it("calls GET /projects/:projectId/tasks/:taskId/chat-support and returns support info", async () => {
      const mockResult = {
        supported: true,
        backend: "claude",
        reason: null,
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: mockResult }),
      } as Response);

      const result = await api.tasks.chatSupport("proj-1", "os-1234");
      expect(result).toEqual(mockResult);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/projects/proj-1/tasks/os-1234/chat-support"),
        expect.any(Object)
      );
    });

    it("returns unsupported for CLI backends", async () => {
      const mockResult = {
        supported: false,
        backend: "cursor",
        reason: "Chat is not available for CLI-based agent backends.",
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: mockResult }),
      } as Response);

      const result = await api.tasks.chatSupport("proj-1", "os-5678");
      expect(result.supported).toBe(false);
      expect(result.backend).toBe("cursor");
      expect(result.reason).toContain("CLI-based");
    });
  });

  describe("feedback", () => {
    it("submit includes priority in body when provided", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 201,
        json: vi.fn().mockResolvedValue({
          data: {
            id: "fb1",
            text: "Critical bug",
            category: "bug",
            mappedPlanId: null,
            createdTaskIds: [],
            status: "pending",
            createdAt: new Date().toISOString(),
          },
        }),
      } as Response);

      await api.feedback.submit("proj-1", "Critical bug", undefined, undefined, 0);
      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body.text).toBe("Critical bug");
      expect(body.priority).toBe(0);
    });

    it("submit omits priority from body when not provided", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 201,
        json: vi.fn().mockResolvedValue({
          data: {
            id: "fb2",
            text: "Normal feedback",
            category: "bug",
            mappedPlanId: null,
            createdTaskIds: [],
            status: "pending",
            createdAt: new Date().toISOString(),
          },
        }),
      } as Response);

      await api.feedback.submit("proj-1", "Normal feedback");
      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body.text).toBe("Normal feedback");
      expect(body).not.toHaveProperty("priority");
    });
  });
});
