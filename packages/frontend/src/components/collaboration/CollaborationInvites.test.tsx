import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CollaborationInvites } from "./CollaborationInvites";
import type { CollaborationSessionState } from "./useCollaborationSession";

const queryClients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of queryClients.splice(0)) client.clear();
  vi.restoreAllMocks();
});
function fixture(actorId = "local-user") {
  const invite = {
    id: "invite-one",
    actorId: "guest-one",
    displayName: "Maya",
    role: "participant",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    revokedAt: null,
  };
  const session = {
    principal: { actorId, role: "controller" },
    queryKey: ["test-sharing", crypto.randomUUID()],
    overview: { data: { shareOrigin: "https://guests.example.test" } },
    client: {
      invites: vi.fn(async () => [invite]),
      createInvite: vi.fn(async () => ({ invite, token: "private-invitation-token" })),
      revokeInvite: vi.fn(async () => {}),
    },
    invalidate: vi.fn(async () => {}),
  } as unknown as CollaborationSessionState;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClients.push(client);
  const result = render(
    <QueryClientProvider client={client}>
      <CollaborationInvites session={session} projectId="project-a" />
    </QueryClientProvider>
  );
  return { ...result, session };
}

describe("focused project sharing", () => {
  it("creates a named invitation with safe defaults without displaying administrative fields", async () => {
    const { session } = fixture();
    const user = userEvent.setup();
    expect(screen.getByRole("combobox", { name: "Access" })).not.toBeVisible();
    expect(screen.getByRole("combobox", { name: "Expires" })).not.toBeVisible();
    expect(screen.queryByRole("button", { name: /Revoke/ })).not.toBeInTheDocument();
    expect(session.client.invites).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox", { name: "Person’s name" }), "Maya");
    await user.click(screen.getByRole("button", { name: "Create invitation" }));
    await waitFor(() => expect(session.client.createInvite).toHaveBeenCalledTimes(1));
    expect(vi.mocked(session.client.createInvite).mock.calls[0][0]).toEqual({
      displayName: "Maya",
      role: "participant",
      expiresInHours: 24,
    });
    const link = await screen.findByRole("textbox", { name: "Private invitation link" });
    expect(link).toHaveValue(
      "https://guests.example.test/collaborate/project-a#invite=private-invitation-token"
    );
    expect(screen.getByRole("status")).toHaveTextContent("Keep this link private");
    expect(window.location.hash).not.toContain("private-invitation-token");
  });

  it("reveals and respects explicit permission and expiry choices", async () => {
    const { session } = fixture();
    const user = userEvent.setup();
    await user.click(screen.getByText("Access and expiry"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Access" }), "viewer");
    await user.selectOptions(screen.getByRole("combobox", { name: "Expires" }), "1");
    await user.type(screen.getByRole("textbox", { name: "Person’s name" }), "Reviewer");
    await user.click(screen.getByRole("button", { name: "Create invitation" }));
    await waitFor(() => expect(session.client.createInvite).toHaveBeenCalledTimes(1));
    expect(vi.mocked(session.client.createInvite).mock.calls[0][0]).toEqual({
      displayName: "Reviewer",
      role: "viewer",
      expiresInHours: 1,
    });
  });

  it("loads past invitations only under Manage access and still supports revocation", async () => {
    const { session } = fixture();
    const user = userEvent.setup();
    expect(session.client.invites).not.toHaveBeenCalled();
    await user.click(screen.getByText("Manage access"));
    const revoke = await screen.findByRole("button", { name: "Revoke Maya invitation" });
    await user.click(revoke);
    await waitFor(() => expect(session.client.revokeInvite).toHaveBeenCalledTimes(1));
    expect(vi.mocked(session.client.revokeInvite).mock.calls[0][0]).toBe("invite-one");
    expect(session.invalidate).toHaveBeenCalled();
  });

  it("never exposes invitation management or fetches its private records for invited controllers", () => {
    const { session } = fixture("invited-controller");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create invitation" })).not.toBeInTheDocument();
    expect(session.client.invites).not.toHaveBeenCalled();
    expect(session.client.createInvite).not.toHaveBeenCalled();
  });
});
