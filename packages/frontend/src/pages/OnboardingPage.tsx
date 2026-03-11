import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Layout } from "../components/layout/Layout";
import { api, isConnectionError } from "../api/client";
import { PREREQ_ITEMS, getPrereqInstallUrl } from "../lib/prerequisites";
import {
  AGENT_PROVIDER_OPTIONS,
  type AgentProviderValue,
} from "../lib/agentProviders";

type PrerequisitesState = { missing: string[]; platform: string } | null;

const NO_KEY_MESSAGE = "No API key needed — you're good to go.";

/**
 * Sanitize intended redirect path to prevent open redirect.
 * Allowed: /, /projects/create-new, /projects/add-existing, /projects/<id>, /projects/<id>/...
 */
function sanitizeIntended(path: string | null | undefined): string {
  const p = typeof path === "string" ? path.trim() : "";
  if (p === "" || !p.startsWith("/")) return "/";
  if (p === "/") return "/";
  if (p === "/projects/create-new" || p === "/projects/add-existing") return p;
  if (p.startsWith("/projects/")) {
    const after = p.slice("/projects/".length);
    const firstSegment = after.split("/")[0];
    if (firstSegment.length > 0) return p;
  }
  return "/";
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
      />
    </svg>
  );
}

function EyeOffIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.98 8.22A10.48 10.48 0 001.93 12C3.23 16.34 7.24 19.5 12 19.5c.99 0 1.95-.14 2.86-.4M6.23 6.23A10.45 10.45 0 0112 4.5c4.76 0 8.77 3.16 10.07 7.5-.72 2.39-2.26 4.43-4.3 5.77M6.23 6.23L3 3M6.23 6.23l3.65 3.65M17.77 17.77L21 21M17.77 17.77l-3.65-3.65M14.12 14.12a3 3 0 11-4.24-4.24M14.12 14.12L9.88 9.88"
      />
    </svg>
  );
}

/**
 * Initial Setup (onboarding) page. Full-page layout with Prerequisites and Agent setup.
 * Optional query param: intended (e.g. /onboarding?intended=/projects/create-new).
 * User can proceed to agent setup regardless of prereq status.
 */
export function OnboardingPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const intendedRaw = searchParams.get("intended") ?? undefined;
  const intended = sanitizeIntended(intendedRaw);
  const [prerequisites, setPrerequisites] = useState<PrerequisitesState>(null);
  const [provider, setProvider] = useState<AgentProviderValue>("claude");
  const [keyValue, setKeyValue] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerOption = AGENT_PROVIDER_OPTIONS.find((o) => o.value === provider);
  const needsKeyInput = providerOption?.needsKeyInput ?? true;

  useEffect(() => {
    api.env
      .getPrerequisites()
      .then((r) => setPrerequisites({ missing: r.missing, platform: r.platform }))
      .catch(() => setPrerequisites(null));
  }, []);

  const handleContinue = async () => {
    setError(null);
    setSaving(true);
    try {
      if (provider === "lmstudio") {
        navigate(intended);
        setSaving(false);
        return;
      }
      if (provider === "custom") {
        await api.env.setGlobalSettings({ useCustomCli: true });
        navigate(intended);
        setSaving(false);
        return;
      }
      const value = keyValue.trim();
      if (!value) {
        setError("Please enter an API key");
        setSaving(false);
        return;
      }
      const apiProvider: "claude" | "cursor" | "openai" | "google" =
        provider === "claude"
          ? "claude"
          : provider === "cursor"
            ? "cursor"
            : provider === "openai"
              ? "openai"
              : "google";
      const { valid, error: validateError } = await api.env.validateKey(apiProvider, value);
      if (!valid) {
        setError(validateError ?? "Invalid API key");
        setSaving(false);
        return;
      }
      const envKey =
        provider === "claude"
          ? "ANTHROPIC_API_KEY"
          : provider === "cursor"
            ? "CURSOR_API_KEY"
            : provider === "openai"
              ? "OPENAI_API_KEY"
              : "GOOGLE_API_KEY";
      await api.env.saveKey(envKey, value);
      navigate(intended);
    } catch (err) {
      const message = isConnectionError(err)
        ? "Unable to connect. Please check your network and try again."
        : err instanceof Error
          ? err.message
          : "Failed to save";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const canContinue =
    provider === "custom" ||
    provider === "lmstudio" ||
    (needsKeyInput && keyValue.trim().length > 0);

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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">
              <div>
                <label
                  htmlFor="onboarding-provider"
                  className="block text-sm font-medium text-theme-fg mb-1"
                >
                  Provider
                </label>
                <select
                  id="onboarding-provider"
                  className="input w-full"
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value as AgentProviderValue);
                    setKeyValue("");
                    setError(null);
                  }}
                  data-testid="onboarding-provider-select"
                >
                  {AGENT_PROVIDER_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                {!needsKeyInput ? (
                  <p
                    className="text-sm text-theme-muted pt-7"
                    data-testid="onboarding-no-key-message"
                  >
                    {NO_KEY_MESSAGE}
                  </p>
                ) : (
                  <>
                    <label
                      htmlFor="onboarding-api-key"
                      className="block text-sm font-medium text-theme-fg mb-1"
                    >
                      API Key
                    </label>
                    <div className="relative flex">
                      <input
                        id="onboarding-api-key"
                        type={showKey ? "text" : "password"}
                        className="input font-mono text-sm w-full pr-10"
                        placeholder={
                          provider === "claude"
                            ? "sk-ant-..."
                            : provider === "cursor"
                              ? "key_..."
                              : provider === "openai"
                                ? "sk-..."
                                : "AIza..."
                        }
                        value={keyValue}
                        onChange={(e) => {
                          setKeyValue(e.target.value);
                          setError(null);
                        }}
                        autoComplete="off"
                        data-testid="onboarding-api-key-input"
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-theme-muted hover:text-theme-text p-1"
                        aria-label={showKey ? "Hide key" : "Show key"}
                        data-testid="onboarding-eye-toggle"
                      >
                        {showKey ? (
                          <EyeOffIcon className="w-4 h-4" />
                        ) : (
                          <EyeIcon className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                    {error && (
                      <p
                        className="mt-1.5 text-sm text-theme-error-text"
                        role="alert"
                        data-testid="onboarding-key-error"
                      >
                        {error}
                      </p>
                    )}
                  </>
                )}
                {error && !needsKeyInput && (
                  <p
                    className="mt-1.5 text-sm text-theme-error-text"
                    role="alert"
                    data-testid="onboarding-key-error"
                  >
                    {error}
                  </p>
                )}
              </div>
            </div>
            <div className="mt-4">
              <button
                type="button"
                onClick={handleContinue}
                disabled={!canContinue || saving}
                className="btn-primary disabled:opacity-50"
                data-testid="onboarding-continue-button"
              >
                {saving ? "Saving…" : "Continue"}
              </button>
            </div>
          </section>

          {intended !== "/" && (
            <p className="text-theme-muted text-xs" data-testid="onboarding-intended">
              Intended destination: {intended}
            </p>
          )}
        </div>
      </div>
    </Layout>
  );
}
