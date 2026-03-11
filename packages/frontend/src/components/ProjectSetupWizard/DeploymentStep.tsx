import type { DeploymentMode } from "@opensprint/shared";

export interface DeploymentStepProps {
  mode: DeploymentMode;
  customCommand: string;
  customWebhook: string;
  onModeChange: (mode: DeploymentMode) => void;
  onCustomCommandChange: (value: string) => void;
  onCustomWebhookChange: (value: string) => void;
}

export function DeploymentStep({
  mode,
  customCommand,
  customWebhook,
  onModeChange,
  onCustomCommandChange,
  onCustomWebhookChange,
}: DeploymentStepProps) {
  return (
    <div className="space-y-4" data-testid="deployment-step">
      <div>
        <span id="deployment-mode-label" className="block text-sm font-medium text-theme-text mb-3">Delivery Mode</span>
        <div className="space-y-3" role="group" aria-labelledby="deployment-mode-label">
          <label htmlFor="deployment-mode-expo" aria-label="Expo.dev - Automatic delivery for React Native and web projects" className="flex items-start gap-3 p-3 rounded-lg border border-theme-border hover:border-theme-info-border cursor-pointer transition-colors">
            <input
              id="deployment-mode-expo"
              type="radio"
              name="deployment"
              value="expo"
              checked={mode === "expo"}
              onChange={() => onModeChange("expo")}
              className="mt-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
            />
            <div>
              <p className="text-sm font-medium text-theme-text">Expo.dev</p>
              <p className="text-xs text-theme-muted">
                Automatic delivery for React Native and web projects
              </p>
            </div>
          </label>
          <label htmlFor="deployment-mode-custom" aria-label="Custom Pipeline - Command or webhook triggered after Execute completion" className="flex items-start gap-3 p-3 rounded-lg border border-theme-border hover:border-theme-info-border cursor-pointer transition-colors">
            <input
              id="deployment-mode-custom"
              type="radio"
              name="deployment"
              value="custom"
              checked={mode === "custom"}
              onChange={() => onModeChange("custom")}
              className="mt-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
            />
            <div>
              <p className="text-sm font-medium text-theme-text">Custom Pipeline</p>
              <p className="text-xs text-theme-muted">
                Command or webhook triggered after Execute completion
              </p>
            </div>
          </label>
        </div>
      </div>
      {mode === "custom" && (
        <div className="space-y-3 pt-2 border-t border-theme-border">
          <div>
            <label htmlFor="deployment-command-input" className="block text-sm font-medium text-theme-text mb-1">
              Delivery command
            </label>
            <input
              id="deployment-command-input"
              type="text"
              className="input w-full font-mono text-sm"
              placeholder="e.g. ./deploy.sh or vercel deploy --prod"
              value={customCommand}
              onChange={(e) => onCustomCommandChange(e.target.value)}
            />
            <p className="mt-1 text-xs text-theme-muted">
              Shell command run from project root after each task completion
            </p>
          </div>
          <div className="text-sm text-theme-muted text-center">— or —</div>
          <div>
            <label htmlFor="deployment-webhook-input" className="block text-sm font-medium text-theme-text mb-1">Webhook URL</label>
            <input
              id="deployment-webhook-input"
              type="url"
              className="input w-full font-mono text-sm"
              placeholder="https://api.example.com/deploy"
              value={customWebhook}
              onChange={(e) => onCustomWebhookChange(e.target.value)}
            />
            <p className="mt-1 text-xs text-theme-muted">
              HTTP POST sent after each task completion (GitHub Actions, Vercel, etc.)
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
