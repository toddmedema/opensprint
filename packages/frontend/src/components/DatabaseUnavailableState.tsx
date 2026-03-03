import { Link } from "react-router-dom";

export function DatabaseUnavailableState({
  message,
  settingsHref,
}: {
  message: string;
  settingsHref: string;
}) {
  return (
    <div
      className="flex flex-1 items-center justify-center px-6 py-12"
      data-testid="database-unavailable-state"
    >
      <div className="max-w-xl rounded-2xl border border-theme-error-border bg-theme-surface p-6 text-center shadow-sm">
        <h2 className="text-xl font-semibold text-theme-text">PostgreSQL unavailable</h2>
        <p className="mt-3 text-sm text-theme-muted">{message}</p>
        <p className="mt-3 text-sm text-theme-muted">
          Project phase content is unavailable until PostgreSQL reconnects.
        </p>
        <Link to={settingsHref} className="btn-primary mt-5 inline-flex">
          Open Settings
        </Link>
      </div>
    </div>
  );
}
