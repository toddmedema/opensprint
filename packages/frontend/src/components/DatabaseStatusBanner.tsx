import { Link, useMatch } from "react-router-dom";
import { useDbStatus } from "../api/hooks";
import { useAppSelector } from "../store";

export function DatabaseStatusBanner() {
  const connectionError = useAppSelector((s) => s.connection?.connectionError ?? false);
  const { data } = useDbStatus();
  const projectMatch = useMatch("/projects/:projectId/*");

  if (connectionError || !data || data.ok) {
    return null;
  }

  const settingsHref = projectMatch?.params.projectId
    ? `/projects/${projectMatch.params.projectId}/settings`
    : "/settings";
  const message =
    data.state === "connecting"
      ? "Reconnecting to PostgreSQL..."
      : data.message ?? "PostgreSQL is unavailable.";

  return (
    <div
      className="flex items-center justify-center gap-3 border-b border-theme-error-border bg-theme-error-bg px-4 py-3 text-theme-error-text shrink-0"
      data-testid="database-status-banner"
      role="alert"
    >
      <p className="text-sm font-medium">{message}</p>
      <Link
        to={settingsHref}
        className="text-sm font-semibold underline underline-offset-2 hover:opacity-80"
      >
        Open Settings
      </Link>
    </div>
  );
}
