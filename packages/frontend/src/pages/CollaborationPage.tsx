import { useLayoutEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { CollaborationSession } from "../components/collaboration/CollaborationSession";

/** Credentials live only in this connection; fragments are removed before the page is painted. */
function CollaborationConnection({ projectId }: { projectId: string }) {
  const [credential, setCredential] = useState("");
  const [connection, setConnection] = useState<{ token?: string; id: string } | null>(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("invite")?.trim();
    return token
      ? { token, id: crypto.randomUUID() }
      : window.__OPENSPRINT_LOCAL_SESSION__
        ? { id: crypto.randomUUID() }
        : null;
  });
  useLayoutEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    if (params.has("invite")) {
      params.delete("invite");
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}${params.size ? `#${params}` : ""}`
      );
    }
  }, []);
  return (
    <main className="min-h-screen bg-theme-bg p-3 text-theme-text sm:p-6">
      {connection ? (
        <CollaborationSession
          key={`${projectId}:${connection.id}`}
          projectId={projectId}
          token={connection.token}
          onLeave={() => setConnection(null)}
        />
      ) : (
        <form
          className="mx-auto max-w-md space-y-4 rounded-xl border border-theme-border p-5 sm:mt-12 sm:p-8"
          onSubmit={(event) => {
            event.preventDefault();
            if (credential.trim()) {
              setConnection({ token: credential.trim(), id: crypto.randomUUID() });
              setCredential("");
            }
          }}
        >
          <div>
            <p className="text-xs text-theme-muted">OPEN SPRINT · EXECUTE</p>
            <h1 className="mt-2 text-xl font-semibold">Join collaboration</h1>
            <p className="mt-2 text-sm text-theme-muted">
              Open your private invitation link, or enter the project access token provided by your
              host.
            </p>
          </div>
          <label className="block text-sm" htmlFor="collaboration-token">
            Project access token
          </label>
          <input
            type="password"
            id="collaboration-token"
            autoComplete="off"
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
            className="w-full rounded-lg border border-theme-border bg-theme-bg p-3"
            required
          />
          <button type="submit" className="btn-primary" disabled={!credential.trim()}>
            Join session
          </button>
          {window.__OPENSPRINT_LOCAL_SESSION__ && (
            <button
              type="button"
              className="btn-secondary ml-2"
              onClick={() => setConnection({ id: crypto.randomUUID() })}
            >
              Use local session
            </button>
          )}
        </form>
      )}
    </main>
  );
}
export function CollaborationPage() {
  const { projectId = "" } = useParams();
  return <CollaborationConnection key={projectId} projectId={projectId} />;
}
