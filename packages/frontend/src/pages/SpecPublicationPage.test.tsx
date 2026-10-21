import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SpecPublicationPage } from "./SpecPublicationPage";
import { getAccessSession, setAccessSession } from "../api/session";

const key = ["spec-publication", "project"];
const draft = {
  revision: 3,
  content: "# Product Specification\n\nReviewed content\n",
  content_hash: "a".repeat(64),
  base_sha: "base-commit",
  base_ref: "refs/heads/main",
};
const operation = {
  operation_id: "persisted-operation",
  revision: 3,
  status: "uncertain",
  error: "Check the interrupted publication.",
  commit_sha: "candidate-commit",
};
const response = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
let client: QueryClient;
let handler: (url: string, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;
function setup() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/projects/project/publication"]}>
        <Routes>
          <Route path="/projects/:projectId/publication" element={<SpecPublicationPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  handler = async (url, init) => {
    if (url.endsWith("/publication/draft")) return response(draft);
    if (url.endsWith("/publication/published")) return response({ content: draft.content });
    if (url.endsWith("/publication/operations")) return response([]);
    if (url.endsWith("/publication/approve")) return response({ approved: true });
    if (url.endsWith("/publication/publish"))
      return response({ ...operation, status: "published" });
    if (url.endsWith("/prd")) return response({ version: 1, sections: {}, changeLog: [] });
    if (url.includes("/auth/session?")) return response(getAccessSession());
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  fetchMock = vi.fn((url: string, init?: RequestInit) => handler(String(url), init));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  setAccessSession(undefined);
});

describe("reviewed SPEC publication", () => {
  it("can publish an exact approval persisted by another session", async () => {
    setAccessSession({
      csrfToken: "csrf",
      projectId: "project",
      principal: {
        actorId: "publisher",
        displayName: "Publisher",
        role: "viewer",
        local: false,
        permissions: ["read", "publish"],
      },
    });
    const fallback = handler;
    handler = async (url, init) =>
      url.endsWith("/publication/draft")
        ? response({ ...draft, approved: true })
        : fallback(url, init);
    setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Validate and publish" })).toBeEnabled()
    );
    expect(screen.getByRole("button", { name: "Approve this revision" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Validate and publish" }));
    await screen.findByText(/Publication published/);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/approve"))).toBe(false);
  });

  it("uses a new operation ID only after the server confirms publication failed", async () => {
    const fallback = handler;
    const attempts: string[] = [];
    handler = async (url, init) => {
      if (url.endsWith("/publication/operations"))
        return response(
          attempts.length ? [{ ...operation, operation_id: attempts[0], status: "failed" }] : []
        );
      if (url.endsWith("/publication/publish")) {
        attempts.push(JSON.parse(String(init?.body)).operationId);
        if (attempts.length === 1)
          return new Response(
            JSON.stringify({
              error: { code: "GATE_FAILED", message: "Validation failed." },
            }),
            { status: 500 }
          );
        return response({ ...operation, operation_id: attempts[1], status: "published" });
      }
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await screen.findByLabelText("Draft content");
    await user.click(screen.getByRole("button", { name: "Approve this revision" }));
    const publish = screen.getByRole("button", { name: "Validate and publish" });
    await waitFor(() => expect(publish).toBeEnabled());
    await user.click(publish);
    await screen.findByText(/Validation failed/);
    await waitFor(() => expect(publish).toBeEnabled());
    await user.click(publish);
    await screen.findByText(/Publication published/);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).not.toBe(attempts[0]);
  });

  it("shows read-only draft content to a member without edit, approval or publish permission", async () => {
    setAccessSession({
      csrfToken: "csrf",
      projectId: "project",
      principal: {
        actorId: "reader",
        displayName: "Reader",
        role: "viewer",
        local: false,
        permissions: ["read"],
      },
    });
    setup();
    expect(await screen.findByLabelText("Draft content")).toBeDisabled();
    for (const name of [
      "Import editor changes",
      "Save draft",
      "Approve this revision",
      "Validate and publish",
    ])
      expect(screen.getByRole("button", { name })).toBeDisabled();
  });

  it("loads published Git content before a draft exists and imports editor changes explicitly", async () => {
    const fallback = handler;
    handler = async (url, init) => {
      if (url.endsWith("/publication/draft")) return response(null);
      if (url.endsWith("/publication/published"))
        return response({ content: "# Published Git specification\n" });
      if (url.endsWith("/publication/import")) return response(draft);
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    expect(await screen.findByLabelText("Draft content")).toHaveValue(
      "# Published Git specification\n"
    );
    expect(screen.getByRole("button", { name: "Approve this revision" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Import editor changes" }));
    await waitFor(() => expect(screen.getByLabelText("Draft content")).toHaveValue(draft.content));
    const imported = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/import"))!;
    expect(imported[1].method).toBe("POST");
    expect(JSON.parse(imported[1].body)).toEqual({ expectedRevision: 0 });
    expect(screen.getByRole("button", { name: "Validate and publish" })).toBeDisabled();
  });

  it("rediscovers a persisted interrupted operation on mount and reconciles its exact identity", async () => {
    const fallback = handler;
    handler = async (url, init) => {
      if (url.endsWith("/publication/operations")) return response([operation]);
      if (url.endsWith(`/operations/${operation.operation_id}`))
        return response({ ...operation, status: "published", error: null });
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await screen.findByText(/Publication uncertain · persisted-operation/);
    await user.click(screen.getByRole("button", { name: "Check publication" }));
    await screen.findByText(/Publication published · persisted-operation/);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith(`/operations/${operation.operation_id}`)
      )
    ).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/publish"))).toBe(false);
  });

  it("binds a late approval response to the submitted revision even when a new draft has the same content hash", async () => {
    let resolveApproval!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveApproval = resolve;
    });
    const fallback = handler;
    let approvalCount = 0;
    handler = (url, init) =>
      url.endsWith("/approve") && ++approvalCount === 1 ? pending : fallback(url, init);
    const user = userEvent.setup();
    setup();
    expect(await screen.findByLabelText("Draft content")).toHaveValue(draft.content);
    await user.click(screen.getByRole("button", { name: "Approve this revision" }));
    await act(async () => {
      client.setQueryData(key, { ...draft, revision: 4, base_sha: "new-base" });
      resolveApproval(response({ approved: true }));
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve this revision" })).toBeEnabled()
    );
    expect(screen.getByRole("button", { name: "Validate and publish" })).toBeDisabled();
    const first = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/approve"))!;
    expect(JSON.parse(first[1].body)).toEqual({ revision: 3, contentHash: draft.content_hash });
    await user.click(screen.getByRole("button", { name: "Approve this revision" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Validate and publish" })).toBeEnabled()
    );
    await user.click(screen.getByRole("button", { name: "Validate and publish" }));
    await screen.findByText(/Publication published/);
    const publication = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/publish"))!;
    expect(JSON.parse(publication[1].body).revision).toBe(4);
  });

  it("keeps the edit's original revision after refetch and preserves local text on a save conflict", async () => {
    const fallback = handler;
    handler = async (url, init) => {
      if (url.endsWith("/publication/draft") && init?.method === "PUT")
        return new Response(
          JSON.stringify({
            error: {
              code: "REVISION_CONFLICT",
              message: "The draft changed. Refresh before saving.",
            },
          }),
          { status: 409 }
        );
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    const field = await screen.findByLabelText("Draft content");
    await user.clear(field);
    await user.type(field, "My unsaved review edits");
    await act(async () => {
      client.setQueryData(key, {
        ...draft,
        revision: 4,
        content: "Another user's draft",
        content_hash: "b".repeat(64),
      });
    });
    expect(field).toHaveValue("My unsaved review edits");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByRole("alert");
    expect(field).toHaveValue("My unsaved review edits");
    const save = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/publication/draft") && init?.method === "PUT"
    )!;
    expect(JSON.parse(save[1].body)).toEqual({
      content: "My unsaved review edits",
      expectedRevision: 3,
    });
    expect(screen.getByRole("button", { name: "Validate and publish" })).toBeDisabled();
  });

  it("surfaces unavailable operation history before allowing a new publication", async () => {
    const fallback = handler;
    handler = async (url, init) => {
      if (url.endsWith("/publication/operations"))
        return new Response(
          JSON.stringify({
            error: { code: "DATABASE_UNAVAILABLE", message: "Publication history is unavailable." },
          }),
          { status: 503 }
        );
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await screen.findByLabelText("Draft content");
    await user.click(screen.getByRole("button", { name: "Approve this revision" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve this revision" })).toBeEnabled()
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Publication history is unavailable.");
    expect(screen.getByRole("button", { name: "Validate and publish" })).toBeDisabled();
  });
});
