import { useState, useCallback } from "react";
import type {
  AgentConfig,
  ApiKeyEntry,
  ApiKeyProvider,
  ApiKeys,
  MaskedApiKeyEntry,
  MaskedApiKeys,
} from "@opensprint/shared";
import { API_KEY_PROVIDERS } from "@opensprint/shared";

const MASKED_PLACEHOLDER = "••••••••";

/** Settings shape for API keys section: agent config + optional apiKeys (e.g. from global settings) */
export interface ApiKeysSectionSettings {
  simpleComplexityAgent: AgentConfig;
  complexComplexityAgent: AgentConfig;
  apiKeys?: ApiKeys;
}

/** Providers that use API keys in the UI (claude API, cursor, openai; excludes claude-cli) */
function getApiKeyProvidersForSection(settings: ApiKeysSectionSettings): ApiKeyProvider[] {
  const providers: ApiKeyProvider[] = [];
  const agents = [settings.simpleComplexityAgent, settings.complexComplexityAgent];
  for (const a of agents) {
    if (a.type === "claude") providers.push("ANTHROPIC_API_KEY");
    if (a.type === "cursor") providers.push("CURSOR_API_KEY");
    if (a.type === "openai") providers.push("OPENAI_API_KEY");
  }
  return [...new Set(providers)];
}

function formatLimitHitAt(limitHitAt: string): string {
  try {
    const d = new Date(limitHitAt);
    if (Number.isNaN(d.getTime())) return limitHitAt;
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return limitHitAt;
  }
}

const PROVIDER_LABELS: Record<ApiKeyProvider, string> = {
  ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY (Claude API)",
  CURSOR_API_KEY: "CURSOR_API_KEY",
  OPENAI_API_KEY: "OPENAI_API_KEY (OpenAI API)",
};

export type ApiKeysSectionVariant = "project" | "global";

interface ApiKeysSectionProps {
  /** Project settings (agent config + apiKeys). Used when variant is "project". */
  settings?: ApiKeysSectionSettings | null;
  /** Global apiKeys (masked from GET /global-settings). Used when variant is "global". */
  apiKeys?: ApiKeys | MaskedApiKeys;
  /** Providers to show. When "global", pass API_KEY_PROVIDERS to show all. */
  providers?: ApiKeyProvider[];
  /** "global" = keys in global settings; "project" = project keys (deprecated). */
  variant?: ApiKeysSectionVariant;
  onApiKeysChange: (apiKeys: Partial<Record<ApiKeyProvider, Array<{ id: string; value?: string; limitHitAt?: string }>>>) => void;
}

export function ApiKeysSection({
  settings = null,
  apiKeys: apiKeysProp,
  providers: providersProp,
  variant = "project",
  onApiKeysChange,
}: ApiKeysSectionProps) {
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());
  const [editedValues, setEditedValues] = useState<Record<string, string>>({});
  const [newKeys, setNewKeys] = useState<Partial<Record<ApiKeyProvider, Array<{ id: string; value: string }>>>>({});

  const providers =
    providersProp ??
    (settings ? getApiKeyProvidersForSection(settings) : []);
  const apiKeys = apiKeysProp ?? settings?.apiKeys;

  if (providers.length === 0) return null;

  const toggleVisible = useCallback((id: string) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const getEntriesForProvider = useCallback(
    (provider: ApiKeyProvider): Array<{ id: string; value: string; limitHitAt?: string }> => {
      const existing = (apiKeys as Record<string, MaskedApiKeyEntry[]> | undefined)?.[provider] ?? [];
      const added = newKeys[provider] ?? [];
      const existingIds = new Set(existing.map((e) => e.id));
      const addedOnly = added.filter((e) => !existingIds.has(e.id));
      return [
        ...existing.map((e) => {
          const raw = e as ApiKeyEntry & MaskedApiKeyEntry;
          const value =
            editedValues[e.id] ?? raw.value ?? raw.masked ?? "";
          return {
            id: e.id,
            value,
            limitHitAt: e.limitHitAt,
          };
        }),
        ...addedOnly.map((e) => ({
          id: e.id,
          value: e.value,
          limitHitAt: undefined as string | undefined,
        })),
      ];
    },
    [apiKeys, newKeys, editedValues]
  );

  const emitApiKeysForProvider = useCallback(
    (
      provider: ApiKeyProvider,
      entries: Array<{ id: string; value: string; limitHitAt?: string }>,
      changedId?: string,
      changedValue?: string
    ) => {
      const payload = entries.map((e) => {
        const value =
          e.id === changedId && changedValue !== undefined
            ? changedValue
            : e.value;
        return {
          id: e.id,
          ...(value && value !== MASKED_PLACEHOLDER ? { value } : {}),
          ...(e.limitHitAt ? { limitHitAt: e.limitHitAt } : {}),
        };
      });
      onApiKeysChange({ [provider]: payload });
    },
    [onApiKeysChange]
  );

  const updateEntryValue = useCallback(
    (provider: ApiKeyProvider, id: string, value: string) => {
      const added = newKeys[provider];
      const isNew = added?.some((e) => e.id === id);
      if (isNew) {
        setNewKeys((prev) => ({
          ...prev,
          [provider]: (prev[provider] ?? []).map((e) =>
            e.id === id ? { ...e, value } : e
          ),
        }));
      } else {
        setEditedValues((prev) => ({ ...prev, [id]: value }));
      }
      const entries = getEntriesForProvider(provider);
      const updatedEntries = entries.map((e) =>
        e.id === id ? { ...e, value } : e
      );
      emitApiKeysForProvider(provider, updatedEntries, id, value);
    },
    [newKeys, getEntriesForProvider, emitApiKeysForProvider]
  );

  const addKey = useCallback(
    (provider: ApiKeyProvider) => {
      const id = crypto.randomUUID();
      setNewKeys((prev) => {
        const existing = prev[provider] ?? [];
        // Idempotent: avoid duplicate add when React Strict Mode double-invokes the updater
        if (existing.some((e) => e.id === id)) return prev;
        return {
          ...prev,
          [provider]: [...existing, { id, value: "" }],
        };
      });
    },
    []
  );

  const removeKey = useCallback(
    (provider: ApiKeyProvider, id: string) => {
      const entries = getEntriesForProvider(provider);
      if (entries.length <= 1) return;
      const isNew = newKeys[provider]?.some((e) => e.id === id);
      if (isNew) {
        setNewKeys((prev) => ({
          ...prev,
          [provider]: (prev[provider] ?? []).filter((e) => e.id !== id),
        }));
      } else {
        setEditedValues((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
      const nextEntries = entries
        .filter((e) => e.id !== id)
        .map((e) => ({
          ...e,
          value:
            editedValues[e.id] ??
            newKeys[provider]?.find((x) => x.id === e.id)?.value ??
            e.value ??
            "",
        }));
      emitApiKeysForProvider(provider, nextEntries);
    },
    [getEntriesForProvider, newKeys, editedValues, emitApiKeysForProvider]
  );

  return (
    <div data-testid="api-keys-section" className="space-y-4">
      <hr className="border-theme-border" />
      <div>
        <h3 className="text-sm font-semibold text-theme-text mb-1">API Keys</h3>
        <p className="text-xs text-theme-muted mb-3">
          {variant === "global"
            ? "Add multiple keys per provider for automatic rotation when limits are hit. Keys are stored globally and used across all projects."
            : "Add multiple keys per provider for automatic rotation when limits are hit. Project keys take precedence over keys in .env when both are configured."}
        </p>
        {providers.map((provider) => {
          const entries = getEntriesForProvider(provider);
          return (
            <div key={provider} className="mb-4">
              <label className="block text-xs font-medium text-theme-muted mb-2">
                {PROVIDER_LABELS[provider]}
              </label>
              <div className="space-y-3">
                {entries.map((entry) => {
                  const isNew = newKeys[provider]?.some((x) => x.id === entry.id);
                  const hasValue = !!(
                    editedValues[entry.id] ??
                    (isNew ? newKeys[provider]?.find((x) => x.id === entry.id)?.value : null) ??
                    entry.value
                  );
                  const displayValue = hasValue
                    ? (editedValues[entry.id] ??
                      newKeys[provider]?.find((x) => x.id === entry.id)?.value ??
                      entry.value ??
                      "")
                    : "";
                  const isVisible = visibleKeys.has(entry.id);
                  const canRemove = entries.length > 1;
                  const placeholder = !hasValue
                    ? (isNew
                        ? provider === "ANTHROPIC_API_KEY"
                          ? "sk-ant-..."
                          : provider === "OPENAI_API_KEY"
                            ? "sk-..."
                            : "key_..."
                        : MASKED_PLACEHOLDER)
                    : undefined;
                  return (
                    <div key={entry.id} className="space-y-1">
                      <div className="flex gap-2 items-center">
                        <div className="flex-1 min-w-0">
                          <div className="relative flex">
                            <input
                              type={isVisible ? "text" : "password"}
                              className="input font-mono text-sm w-full pr-10"
                              placeholder={placeholder}
                              value={displayValue}
                              onChange={(e) =>
                                updateEntryValue(provider, entry.id, e.target.value)
                              }
                              autoComplete="off"
                              data-testid={`api-key-input-${provider}-${entry.id}`}
                            />
                            <button
                              type="button"
                              onClick={() => toggleVisible(entry.id)}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-theme-muted hover:text-theme-text p-1"
                              aria-label={isVisible ? "Hide key" : "Show key"}
                              data-testid={`api-key-eye-${provider}-${entry.id}`}
                            >
                              {isVisible ? (
                                <EyeOffIcon className="w-4 h-4" />
                              ) : (
                                <EyeIcon className="w-4 h-4" />
                              )}
                            </button>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeKey(provider, entry.id)}
                          disabled={!canRemove}
                          className="text-theme-error-text hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed p-1 shrink-0"
                          aria-label="Remove key"
                          data-testid={`api-key-remove-${provider}-${entry.id}`}
                        >
                          <RemoveIcon className="w-4 h-4" />
                        </button>
                      </div>
                      {entry.limitHitAt && (
                        <p className="text-xs text-theme-muted">
                          Limit hit at {formatLimitHitAt(entry.limitHitAt)} — retry after 24h
                        </p>
                      )}
                    </div>
                  );
                })}
                <button
                  type="button"
                  onClick={() => addKey(provider)}
                  className="btn-secondary text-sm"
                  data-testid={`api-key-add-${provider}`}
                >
                  + Add key
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878a4.5 4.5 0 106.262 6.262M4.031 11.117A9.956 9.956 0 004 12c0 4.478 2.943 8.268 7 9.542 1.274.357 2.648.542 4 .542.89 0 1.76-.127 2.587-.364m-1.746-1.746A9.958 9.958 0 015.458 12"
      />
    </svg>
  );
}

function RemoveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
      />
    </svg>
  );
}
