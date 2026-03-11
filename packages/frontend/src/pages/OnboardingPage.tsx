import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Layout } from "../components/layout/Layout";
import { api } from "../api/client";
import { PREREQ_ITEMS, getPrereqInstallUrl } from "../lib/prerequisites";

type PrerequisitesState = { missing: string[]; platform: string } | null;

/**
 * Initial Setup (onboarding) page. Full-page layout with Prerequisites and Agent setup.
 * Optional query param: intended (e.g. /onboarding?intended=/projects/create-new).
 * User can proceed to agent setup regardless of prereq status.
 */
export function OnboardingPage() {
  const [searchParams] = useSearchParams();
  const intended = searchParams.get("intended") ?? undefined;
  const [prerequisites, setPrerequisites] = useState<PrerequisitesState>(null);

  useEffect(() => {
    api.env
      .getPrerequisites()
      .then((r) => setPrerequisites({ missing: r.missing, platform: r.platform }))
      .catch(() => setPrerequisites(null));
  }, []);

  return (
    <Layout>
      <div
        className="flex-1 min-h-0 flex flex-col overflow-hidden bg-theme-surface"
        data-testid="onboarding-page"
      >
        <div className="flex-1 min-h-0 overflow-y-auto max-w-[1440px] mx-auto w-full px-4 sm:px-6 pt-6 pb-8">
          <h1 className="text-2xl font-semibold text-theme-fg mb-6" data-testid="onboarding-title">
            Initial Setup
          </h1>

          <section
            className="mb-8"
            aria-labelledby="prerequisites-heading"
            data-testid="onboarding-prerequisites"
          >
            <h2 id="prerequisites-heading" className="text-lg font-medium text-theme-fg mb-3">
              Prerequisites
            </h2>
            {prerequisites === null ? (
              <p className="text-theme-muted text-sm">Checking Git and Node.js…</p>
            ) : (
              <ul className="space-y-2">
                {PREREQ_ITEMS.map((tool) => {
                  const isMissing = prerequisites.missing.includes(tool);
                  const rowTestId = `prereq-row-${tool.toLowerCase().replace(".", "")}`;
                  const installTestId = `prereq-install-${tool.toLowerCase().replace(".", "")}`;
                  return (
                    <li
                      key={tool}
                      className="flex items-center justify-between gap-3 text-sm"
                      data-testid={rowTestId}
                    >
                      <span className="text-theme-fg font-medium">{tool}</span>
                      {isMissing ? (
                        <a
                          href={getPrereqInstallUrl(tool, prerequisites.platform)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-theme-accent hover:underline"
                          data-testid={installTestId}
                        >
                          Install {tool}
                        </a>
                      ) : (
                        <span
                          className="text-theme-muted flex items-center gap-1.5"
                          aria-label={`${tool} installed`}
                        >
                          <span className="text-green-600 dark:text-green-400" aria-hidden>
                            ✓
                          </span>
                          Installed
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section
            className="mb-8"
            aria-labelledby="agent-setup-heading"
            data-testid="onboarding-agent-setup"
          >
            <h2 id="agent-setup-heading" className="text-lg font-medium text-theme-fg mb-3">
              Agent setup
            </h2>
            <p className="text-theme-muted text-sm">Placeholder: Provider and API key configuration will appear here.</p>
          </section>

          {intended !== undefined && (
            <p className="text-theme-muted text-xs" data-testid="onboarding-intended">
              Intended destination: {intended}
            </p>
          )}
        </div>
      </div>
    </Layout>
  );
}
