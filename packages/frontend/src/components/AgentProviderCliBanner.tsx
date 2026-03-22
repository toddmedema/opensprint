import { useState } from "react";
import { api } from "../api/client";
import type { AgentCliCheckKind } from "../lib/agentProviderCli";

export interface AgentProviderCliBannerProps {
  kind: AgentCliCheckKind;
  /** Called after the install request finishes (success or failure) so parents can refetch /env/keys. */
  onInstallAttemptComplete?: () => void;
}

/**
 * Warning + optional install for agent CLIs (Cursor). Claude/Ollama are docs-only.
 */
export function AgentProviderCliBanner({
  kind,
  onInstallAttemptComplete,
}: AgentProviderCliBannerProps) {
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<{ success: boolean; message: string } | null>(
    null
  );

  if (kind === "cursor") {
    return (
      <div
        className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
        data-testid="agent-provider-cli-banner-cursor"
      >
        <p className="text-sm text-theme-warning-text mb-2">
          <strong>Cursor CLI not found.</strong> The{" "}
          <code className="font-mono text-xs">agent</code> command is required for Cursor. Install it,
          then restart your terminal or Open Sprint.
        </p>
        <button
          type="button"
          className="btn btn-primary text-sm"
          disabled={installing}
          onClick={async () => {
            setInstallResult(null);
            setInstalling(true);
            try {
              const data = await api.env.installCursorCli();
              setInstallResult({
                success: data.success,
                message: data.message ?? (data.success ? "Install finished." : "Install failed."),
              });
            } catch (err) {
              setInstallResult({
                success: false,
                message: err instanceof Error ? err.message : "Install request failed.",
              });
            } finally {
              setInstalling(false);
              onInstallAttemptComplete?.();
            }
          }}
          data-testid="install-cursor-cli-btn"
        >
          {installing ? "Installing…" : "Install Cursor CLI"}
        </button>
        {installResult && (
          <p
            className={`text-sm mt-2 ${installResult.success ? "text-theme-success-text" : "text-theme-error-text"}`}
          >
            {installResult.message}
          </p>
        )}
      </div>
    );
  }

  if (kind === "ollama") {
    return (
      <div
        className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
        data-testid="agent-provider-cli-banner-ollama"
      >
        <p className="text-sm text-theme-warning-text">
          <strong>Ollama CLI not found.</strong> Install Ollama from{" "}
          <a
            href="https://ollama.com/download"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:opacity-80"
          >
            ollama.com/download
          </a>{" "}
          and ensure the <code className="font-mono text-xs">ollama</code> command is available in
          your terminal.
        </p>
      </div>
    );
  }

  return (
    <div
      className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
      data-testid="agent-provider-cli-banner-claude"
    >
      <p className="text-sm text-theme-warning-text">
        <strong>Claude CLI not found.</strong> Install it from{" "}
        <a
          href="https://docs.anthropic.com/en/docs/claude-code/getting-started"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:opacity-80"
        >
          docs.anthropic.com
        </a>{" "}
        and run <code className="font-mono text-xs">claude</code> to complete authentication.
      </p>
    </div>
  );
}
