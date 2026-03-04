import { CloseButton } from "./CloseButton";
import { GlobalSettingsContent } from "./GlobalSettingsContent";

interface DisplaySettingsModalProps {
  onClose: () => void;
}

/**
 * Global display settings modal (homepage or when no project selected).
 * Shows theme and running agents display mode — stored in localStorage (opensprint.theme,
 * opensprint.runningAgentsDisplayMode) per PRD UserPreferences.
 */
export function DisplaySettingsModal({ onClose }: DisplaySettingsModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-theme-overlay backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col"
        data-testid="display-settings-modal"
      >
        <div className="flex-shrink-0 flex items-center justify-between px-5 py-4 border-b border-theme-border">
          <h2 className="text-lg font-semibold text-theme-text">Settings</h2>
          <CloseButton onClick={onClose} ariaLabel="Close settings modal" />
        </div>
        <div className="px-5 py-4 pt-[15px]">
          <GlobalSettingsContent />
        </div>
      </div>
    </div>
  );
}
