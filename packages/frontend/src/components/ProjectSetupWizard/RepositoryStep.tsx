export interface RepositoryStepProps {
  value: string;
  onChange: (value: string) => void;
  onBrowse: () => void;
  /** When true, shows "Project files will be created in this folder" (Create New flow) */
  createNewMode?: boolean;
  validationMessage?: string | null;
}

export function RepositoryStep({
  value,
  onChange,
  onBrowse,
  createNewMode,
  validationMessage,
}: RepositoryStepProps) {
  const helperText = createNewMode
    ? "Project files will be created in this folder"
    : "Absolute path where the project repo will be created";

  return (
    <div className="space-y-4" data-testid="repository-step">
      <div>
        <label className="block text-sm font-medium text-theme-text mb-1">Project folder</label>
        <div className="flex gap-2">
          <input
            type="text"
            className="input font-mono text-sm flex-1"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="/Users/you/projects/my-app"
          />
          <button
            type="button"
            onClick={onBrowse}
            className="btn-secondary text-sm px-3 whitespace-nowrap flex items-center gap-1.5"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
              />
            </svg>
            Browse
          </button>
        </div>
        <p className="mt-1 text-xs text-theme-muted" data-testid="repository-step-helper">
          {helperText}
        </p>
        {validationMessage && (
          <p className="mt-2 text-xs text-theme-error-text" data-testid="repository-step-error">
            {validationMessage}
          </p>
        )}
      </div>
    </div>
  );
}
