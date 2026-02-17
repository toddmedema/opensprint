import { ModelSelect } from "../ModelSelect";
import type { AgentType } from "@opensprint/shared";

export interface AgentConfig {
  type: AgentType;
  model: string;
  cliCommand: string;
}

export interface EnvKeys {
  anthropic: boolean;
  cursor: boolean;
}

export interface AgentsStepProps {
  planningAgent: AgentConfig;
  codingAgent: AgentConfig;
  onPlanningAgentChange: (config: AgentConfig) => void;
  onCodingAgentChange: (config: AgentConfig) => void;
  envKeys: EnvKeys | null;
  keyInput: { anthropic: string; cursor: string };
  onKeyInputChange: (key: "anthropic" | "cursor", value: string) => void;
  savingKey: "ANTHROPIC_API_KEY" | "CURSOR_API_KEY" | null;
  onSaveKey: (key: "ANTHROPIC_API_KEY" | "CURSOR_API_KEY") => void;
  modelRefreshTrigger: number;
}

export function AgentsStep({
  planningAgent,
  codingAgent,
  onPlanningAgentChange,
  onCodingAgentChange,
  envKeys,
  keyInput,
  onKeyInputChange,
  savingKey,
  onSaveKey,
  modelRefreshTrigger,
}: AgentsStepProps) {
  const needsApiKeys = envKeys && (!envKeys.anthropic || !envKeys.cursor);

  return (
    <div className="space-y-6" data-testid="agents-step">
      {needsApiKeys && (
        <>
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
            <p className="text-sm text-amber-800">
              <strong>API keys required:</strong> Add <code className="font-mono text-xs">ANTHROPIC_API_KEY</code>{" "}
              and/or <code className="font-mono text-xs">CURSOR_API_KEY</code> to your project&apos;s{" "}
              <code className="font-mono text-xs">.env</code> file to use Claude and Cursor. Get keys from{" "}
              <a
                href="https://console.anthropic.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-amber-900"
              >
                Anthropic Console
              </a>{" "}
              and{" "}
              <a
                href="https://cursor.com/settings"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-amber-900"
              >
                Cursor → Integrations → User API Keys
              </a>
              .
            </p>
          </div>
          <div className="space-y-3">
            {envKeys && !envKeys.anthropic && (
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-500 mb-1">ANTHROPIC_API_KEY (Claude)</label>
                  <input
                    type="password"
                    className="input font-mono text-sm"
                    placeholder="sk-ant-..."
                    value={keyInput.anthropic}
                    onChange={(e) => onKeyInputChange("anthropic", e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onSaveKey("ANTHROPIC_API_KEY")}
                  disabled={!keyInput.anthropic.trim() || savingKey !== null}
                  className="btn-primary text-sm disabled:opacity-50"
                >
                  {savingKey === "ANTHROPIC_API_KEY" ? "Saving…" : "Save"}
                </button>
              </div>
            )}
            {envKeys && !envKeys.cursor && (
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-500 mb-1">CURSOR_API_KEY</label>
                  <input
                    type="password"
                    className="input font-mono text-sm"
                    placeholder="key_..."
                    value={keyInput.cursor}
                    onChange={(e) => onKeyInputChange("cursor", e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onSaveKey("CURSOR_API_KEY")}
                  disabled={!keyInput.cursor.trim() || savingKey !== null}
                  className="btn-primary text-sm disabled:opacity-50"
                >
                  {savingKey === "CURSOR_API_KEY" ? "Saving…" : "Save"}
                </button>
              </div>
            )}
          </div>
        </>
      )}
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Planning Agent Slot</h3>
        <p className="text-xs text-gray-500 mb-3">Used by Dreamer, Planner, Harmonizer, Analyst, Summarizer, Auditor, Delta Planner</p>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
              <select
                className="input"
                value={planningAgent.type}
                onChange={(e) => onPlanningAgentChange({ ...planningAgent, type: e.target.value as AgentType })}
              >
                <option value="claude">Claude</option>
                <option value="cursor">Cursor</option>
                <option value="custom">Custom CLI</option>
              </select>
            </div>
            {planningAgent.type !== "custom" && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                <ModelSelect
                  provider={planningAgent.type}
                  value={planningAgent.model || null}
                  onChange={(id) => onPlanningAgentChange({ ...planningAgent, model: id ?? "" })}
                  refreshTrigger={modelRefreshTrigger}
                />
              </div>
            )}
          </div>
          {planningAgent.type === "custom" && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">CLI command</label>
              <input
                type="text"
                className="input w-full font-mono text-sm"
                placeholder="e.g. my-agent or /usr/local/bin/my-agent --model gpt-4"
                value={planningAgent.cliCommand}
                onChange={(e) => onPlanningAgentChange({ ...planningAgent, cliCommand: e.target.value })}
              />
              <p className="mt-1 text-xs text-gray-500">
                Command invoked with prompt as argument. Must accept input and produce output.
              </p>
            </div>
          )}
        </div>
      </div>
      <hr />
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Coding Agent Slot</h3>
        <p className="text-xs text-gray-500 mb-3">Used by Coder and Reviewer for Execute phase implementation and review</p>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
              <select
                className="input"
                value={codingAgent.type}
                onChange={(e) => onCodingAgentChange({ ...codingAgent, type: e.target.value as AgentType })}
              >
                <option value="claude">Claude</option>
                <option value="cursor">Cursor</option>
                <option value="custom">Custom CLI</option>
              </select>
            </div>
            {codingAgent.type !== "custom" && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                <ModelSelect
                  provider={codingAgent.type}
                  value={codingAgent.model || null}
                  onChange={(id) => onCodingAgentChange({ ...codingAgent, model: id ?? "" })}
                  refreshTrigger={modelRefreshTrigger}
                />
              </div>
            )}
          </div>
          {codingAgent.type === "custom" && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">CLI command</label>
              <input
                type="text"
                className="input w-full font-mono text-sm"
                placeholder="e.g. my-agent or /usr/local/bin/my-agent --model gpt-4"
                value={codingAgent.cliCommand}
                onChange={(e) => onCodingAgentChange({ ...codingAgent, cliCommand: e.target.value })}
              />
              <p className="mt-1 text-xs text-gray-500">
                Command invoked with prompt as argument. Must accept input and produce output.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
