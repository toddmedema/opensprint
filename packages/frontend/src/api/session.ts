import type { ProjectIdentity } from "@opensprint/shared";
export interface AccessSession {
  principal: ProjectIdentity;
  csrfToken: string;
  projectId?: string;
  projects?: string[] | null;
}
let session: AccessSession | undefined;
export function setAccessSession(value: AccessSession | undefined) {
  session = value;
}
export function getAccessSession() {
  return session;
}
export function sessionHeaders(): Record<string, string> {
  const token = typeof window === "undefined" ? undefined : window.__OPENSPRINT_LOCAL_SESSION__;
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(session ? { "X-OpenSprint-CSRF": session.csrfToken } : {}),
  };
}
