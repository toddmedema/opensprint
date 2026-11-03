import type { DeliveryMode } from "@opensprint/shared";

export function CodeDeliverySelect({
  value,
  baseBranch,
  onChange,
}: {
  value: DeliveryMode;
  baseBranch: string;
  onChange: (value: DeliveryMode) => void;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor="delivery-mode" className="block text-sm font-semibold text-theme-text">
        Code delivery
      </label>
      <select
        id="delivery-mode"
        className="input w-full"
        value={value}
        onChange={(e) => onChange(e.target.value as DeliveryMode)}
        aria-describedby="delivery-mode-help"
      >
        <option value="direct">Commit directly to {baseBranch}</option>
        <option value="pull_request">Submit a pull request for each plan</option>
      </select>
      <p id="delivery-mode-help" className="text-xs text-theme-muted">
        {value === "pull_request"
          ? "Each plan uses a shared branch. Completed plans open a GitHub PR for you to review and merge. Requires an origin remote and GitHub CLI sign-in."
          : "Completed work is merged into the base branch automatically after checks pass."}
      </p>
    </div>
  );
}
