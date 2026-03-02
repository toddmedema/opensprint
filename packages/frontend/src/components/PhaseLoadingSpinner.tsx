/** Centered animated OpenSprint logo for phase pages during initial fetch.
 * Three arrows pulse to indicate loading. No fake/placeholder content. */
export function PhaseLoadingSpinner({
  "data-testid": dataTestId = "phase-loading-spinner",
  "aria-label": ariaLabel = "Loading",
}: {
  "data-testid"?: string;
  "aria-label"?: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 py-10"
      data-testid={dataTestId}
      role="status"
      aria-label={ariaLabel}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 80 80"
        className="w-12 h-12"
        aria-hidden
      >
        <polygon
          points="4,10 36,40 4,70"
          fill="#c7d2fe"
          className="animate-logo-pulse [animation-delay:0ms]"
        />
        <polygon
          points="22,10 54,40 22,70"
          fill="#818cf8"
          className="animate-logo-pulse [animation-delay:200ms]"
        />
        <polygon
          points="40,10 72,40 40,70"
          fill="#4f46e5"
          className="animate-logo-pulse [animation-delay:400ms]"
        />
      </svg>
    </div>
  );
}
