interface CloseButtonProps {
  onClick: () => void;
  /** Accessible label for screen readers. Default: "Close" */
  ariaLabel?: string;
  /** Additional CSS classes. Default styling: gray icon, hover states */
  className?: string;
  /** Icon size in Tailwind units (e.g. "w-5 h-5"). Default: "w-5 h-5" */
  size?: string;
}

/**
 * Standardized close control: X icon button for modals and panels.
 * Use consistently across the app for modal headers and panel headers.
 */
export function CloseButton({
  onClick,
  ariaLabel = "Close",
  className = "p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors",
  size = "w-5 h-5",
}: CloseButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={className}
      aria-label={ariaLabel}
    >
      <svg className={size} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  );
}
