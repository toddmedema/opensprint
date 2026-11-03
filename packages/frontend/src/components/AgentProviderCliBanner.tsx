import { useState } from "react";
import { api } from "../api/client";
import type { AgentCliCheckKind } from "../lib/agentProviderCli";

export interface AgentProviderCliBannerProps {
  kind: AgentCliCheckKind;
  /** Called after the install request finishes (success or failure) so parents can refetch /env/keys. */
  onInstallAttemptComplete?: () => void;
}

/**
 * Warning + optional install for agent CLIs. Shows manual install instructions
 * instead of piping remote scripts to avoid supply-chain compromise risk.
 */
export function AgentProviderCliBanner({
  kind,
  onInstallAttemptComplete,
}: AgentProviderCliBannerProps) {
  const [showInstructions, setShowInstructions] = useState(false);
  const [instructions, setInstructions] = useState<{
    installUrl: string;
    manualCommand: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (kind === "codex") {
    return (
      <div
        className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
        data-testid="agent-provider-cli-banner-codex"
      >
        <p className="text-sm text-theme-warning-text">
          <strong>Codex CLI not found.</strong> Install the{" "}
          <a
            href="https://learn.chatgpt.com/docs/codex/cli"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            OpenAI Codex CLI
          </a>
          , then run <code>codex login</code> and sign in with ChatGPT. No API key is required.
        </p>
      </div>
    );
  }
  if (kind === "cursor") {
    return (
      <div
        className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
        data-testid="agent-provider-cli-banner-cursor"
      >
        <p className="text-sm text-theme-warning-text mb-2">
          <strong>Cursor CLI not found.</strong> The{" "}
          <code className="font-mono text-xs">agent</code> command is required for Cursor. Install
          it, then restart your terminal or Open Sprint.
        </p>
        <button
          type="button"
          className="btn btn-primary text-sm"
          disabled={loading}
          onClick={async () => {
            if (showInstructions && instructions) {
              setShowInstructions(false);
              return;
            }
            setError(null);
            setLoading(true);
            try {
              const data = await api.env.installCursorCli();
              setInstructions({
                installUrl: data.installUrl,
                manualCommand: data.manualCommand,
              });
              setShowInstructions(true);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Failed to load install instructions.");
            } finally {
              setLoading(false);
              onInstallAttemptComplete?.();
            }
          }}
          data-testid="install-cursor-cli-btn"
        >
          {loading
            ? "Loading…"
            : showInstructions
              ? "Hide Install Instructions"
              : "Show Install Instructions"}
        </button>
        {error && <p className="text-sm mt-2 text-theme-error-text">{error}</p>}
        {showInstructions && instructions && (
          <div className="mt-3 space-y-2" data-testid="cursor-cli-install-instructions">
            <p className="text-sm text-theme-warning-text">
              Run this command in your terminal after reviewing it:
            </p>
            <div className="flex items-center gap-2">
              <code className="block flex-1 p-2 rounded bg-theme-bg-secondary text-xs font-mono break-all select-all">
                {instructions.manualCommand}
              </code>
              <button
                type="button"
                className="btn btn-secondary text-xs px-2 py-1 shrink-0"
                data-testid="copy-cursor-cli-cmd-btn"
                onClick={() => {
                  navigator.clipboard.writeText(instructions.manualCommand).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  });
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="text-xs text-theme-text-secondary">
              Or visit{" "}
              <a
                href={instructions.installUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:opacity-80"
                data-testid="cursor-cli-install-link"
              >
                {instructions.installUrl}
              </a>{" "}
              for official install instructions.
            </p>
          </div>
        )}
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
          href="https://code.claude.com/docs/en/setup"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:opacity-80"
        >
          code.claude.com
        </a>{" "}
        and run <code className="font-mono text-xs">claude</code> to complete authentication.
      </p>
    </div>
  );
}
