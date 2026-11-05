import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import type { IntegrationProvider } from "@opensprint/shared";
import { TodoistIntegrationCard } from "./TodoistIntegrationCard";
import { GitHubIntegrationCard } from "./GitHubIntegrationCard";
import { IntegrationProviderCards } from "../intake/IntegrationProviderCards";

const INTAKE_PLACEHOLDER_PROVIDERS = [
  "slack",
  "webhook",
] as const satisfies readonly IntegrationProvider[];

export interface IntegrationsSettingsContentProps {
  projectId: string;
}

/**
 * Project settings — Integrations tab: third-party sources and related links.
 * GitHub issues become plans; Todoist tasks become Evaluate feedback.
 */
export function IntegrationsSettingsContent({ projectId }: IntegrationsSettingsContentProps) {
  const [notice, setNotice] = useState<string | null>(null);

  const showComingSoon = useCallback((label: string) => {
    setNotice(`${label} is not available in this build yet.`);
  }, []);

  const noop = useCallback(() => {}, []);

  return (
    <div className="space-y-6" data-testid="integrations-settings-content">
      <div className="space-y-2">
        <p className="text-sm text-theme-muted">
          Import GitHub issues into <span className="text-theme-text">Plan</span> and Todoist tasks
          into <span className="text-theme-text">Evaluate</span>. Post-build deploy commands and
          outbound CI webhooks are configured on the{" "}
          <Link
            to={`/projects/${projectId}/settings?tab=deployment`}
            className="text-brand-600 hover:underline font-medium"
            data-testid="integrations-link-deployment-tab"
          >
            Deliver
          </Link>{" "}
          tab.
        </p>
      </div>

      {notice && (
        <div
          className="rounded-lg border border-theme-border bg-theme-bg-elevated px-3 py-2 text-sm text-theme-text flex items-start justify-between gap-3"
          role="status"
          aria-live="polite"
          data-testid="integrations-notice-banner"
        >
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="shrink-0 text-theme-muted hover:text-theme-text text-xs"
            aria-label="Dismiss notice"
          >
            Dismiss
          </button>
        </div>
      )}

      <section className="space-y-3" aria-labelledby="integrations-intake-heading">
        <h2 id="integrations-intake-heading" className="text-sm font-semibold text-theme-text">
          Connected sources
        </h2>
        <div
          className="grid grid-cols-1 sm:grid-cols-2 gap-3"
          data-testid="integration-provider-cards"
        >
          <TodoistIntegrationCard projectId={projectId} />
          <GitHubIntegrationCard projectId={projectId} />
          <IntegrationProviderCards
            asGrid={false}
            providerFilter={INTAKE_PLACEHOLDER_PROVIDERS}
            connections={{}}
            onConnect={(p) => {
              const label = p === "slack" ? "Slack" : "Inbound webhook";
              showComingSoon(label);
            }}
            onConfigure={(p) => {
              const label = p === "slack" ? "Slack" : "Inbound webhook";
              showComingSoon(label);
            }}
            onSync={noop}
            onDisconnect={noop}
          />
        </div>
      </section>
    </div>
  );
}
