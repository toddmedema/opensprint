import type { PlanComplexity } from "@opensprint/shared";

export interface ComplexityIconProps {
  /** Task-level complexity (1-10) or plan-level (low|medium|high|very_high). Legacy "simple"/"complex" accepted for display. */
  complexity: number | PlanComplexity | "simple" | "complex" | undefined;
  size?: "xs" | "sm" | "md";
  className?: string;
}

const SIZE_CLASSES: Record<"xs" | "sm" | "md", string> = {
  xs: "w-3 h-3",
  sm: "w-4 h-4",
  md: "w-5 h-5",
};

/** Simple (low/1-5): one dot, blue. Complex (high/6-10): three dots in triangle, yellow. */
export function ComplexityIcon({
  complexity,
  size = "sm",
  className = "",
}: ComplexityIconProps) {
  if (complexity === undefined || complexity === null) return null;

  const sizeClass = SIZE_CLASSES[size];
  const isSimple =
    typeof complexity === "number"
      ? complexity >= 1 && complexity <= 5
      : complexity === "low" || complexity === "simple";
  const ariaLabel =
    typeof complexity === "string" && ["low", "medium", "high", "very_high"].includes(complexity)
      ? `${complexity} complexity`
      : isSimple
        ? "Simple complexity"
        : typeof complexity === "number"
          ? `Complexity ${complexity}`
          : complexity === "complex"
            ? "Complex complexity"
            : `${complexity} complexity`;

  return (
    <svg
      className={`${sizeClass} shrink-0 ${className}`.trim()}
      viewBox="0 0 16 16"
      role="img"
      aria-label={ariaLabel}
    >
      {isSimple ? (
        <circle cx="8" cy="8" r="3" fill="#0065ff" />
      ) : (
        <>
          <circle cx="8" cy="4.5" r="2.5" fill="#FFAB00" />
          <circle cx="4" cy="11.5" r="2.5" fill="#FFAB00" />
          <circle cx="12" cy="11.5" r="2.5" fill="#FFAB00" />
        </>
      )}
    </svg>
  );
}
