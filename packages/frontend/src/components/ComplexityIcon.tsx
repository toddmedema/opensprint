import type { TaskComplexity } from "@opensprint/shared";
import type { PlanComplexity } from "@opensprint/shared";

export interface ComplexityIconProps {
  /** Task-level complexity (low|high) or plan-level (low|medium|high|very_high). Simple = low; Complex = medium/high/very_high. */
  complexity: TaskComplexity | PlanComplexity | undefined;
  size?: "xs" | "sm" | "md";
  className?: string;
}

const SIZE_CLASSES: Record<"xs" | "sm" | "md", string> = {
  xs: "w-3 h-3",
  sm: "w-4 h-4",
  md: "w-5 h-5",
};

/** Simple (low): one dot, blue. Complex (medium/high/very_high): three dots in triangle, yellow. */
export function ComplexityIcon({
  complexity,
  size = "sm",
  className = "",
}: ComplexityIconProps) {
  if (!complexity) return null;

  const sizeClass = SIZE_CLASSES[size];
  const isSimple =
    complexity === "low";
  const ariaLabel = isSimple ? "Low complexity" : `${complexity} complexity`;

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
