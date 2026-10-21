import { useEffect, useState, type ReactNode } from "react";
import { request } from "../api/client";
import { setAccessSession, type AccessSession } from "../api/session";
export function AccessGate({ children }: { children: ReactNode }) {
  const local =
    typeof document === "undefined" ||
    !document.querySelector('meta[name="opensprint-shared-host"]');
  const [ready, setReady] = useState(local);
  const [checking, setChecking] = useState(!local);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (local) return;
    let active = true;
    void request<AccessSession>("/auth/session")
      .then((value) => {
        if (active) {
          setAccessSession(value);
          setReady(true);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [local]);
  if (ready) return <>{children}</>;
  if (checking)
    return (
      <p role="status" className="p-6">
        Checking session…
      </p>
    );
  return (
    <main className="mx-auto max-w-lg space-y-4 p-8">
      <h1 className="text-xl font-semibold">Sign in to Open Sprint</h1>
      <p>
        Enter your invitation or host access token. Your session stays in a secure browser cookie.
      </p>
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            let value: AccessSession;
            try {
              value = await request<AccessSession>("/auth/redeem", {
                method: "POST",
                body: JSON.stringify({ token: token.trim() }),
              });
            } catch {
              value = await request<AccessSession>("/auth/session", {
                method: "POST",
                body: JSON.stringify({ token: token.trim() }),
              });
            }
            setAccessSession(value);
            setToken("");
            setReady(true);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Sign in failed.");
          }
        }}
      >
        <label className="block">
          Invitation or access token
          <input
            autoComplete="off"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            className="mt-1 w-full rounded border p-2 text-black"
          />
        </label>
        <button className="rounded border px-4 py-2" disabled={!token.trim()}>
          Sign in
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    </main>
  );
}
