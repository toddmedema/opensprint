import { useState, useEffect, useRef } from "react";

/** Delay before showing empty state when fetch completes with empty data (avoids flash) */
export const PHASE_EMPTY_DELAY_MS = 300;

/** Delay before showing loading spinner (avoids flash on rapid responses) */
export const PHASE_SPINNER_DELAY_MS = 300;

/**
 * Returns { showSpinner, showEmptyState } for phase pages:
 * - During fetch: showSpinner=true after PHASE_SPINNER_DELAY_MS (avoids flash on fast responses)
 * - After fetch with data: showSpinner=false, showEmptyState=false
 * - After fetch with empty: wait PHASE_EMPTY_DELAY_MS, then showEmptyState=true
 * - During empty-state delay: keep showing spinner only if we had shown it during load
 */
export function usePhaseLoadingState(
  isLoading: boolean,
  isEmpty: boolean,
  delayMs: number = PHASE_EMPTY_DELAY_MS,
  spinnerDelayMs: number = PHASE_SPINNER_DELAY_MS
): { showSpinner: boolean; showEmptyState: boolean } {
  const [showEmptyState, setShowEmptyState] = useState(false);
  const [showSpinnerAfterDelay, setShowSpinnerAfterDelay] = useState(false);
  const [hadShownSpinner, setHadShownSpinner] = useState(false);
  const emptyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spinnerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Spinner delay: only show spinner after isLoading has been true for spinnerDelayMs */
  useEffect(() => {
    if (isLoading) {
      spinnerTimerRef.current = setTimeout(() => {
        spinnerTimerRef.current = null;
        setShowSpinnerAfterDelay(true);
        setHadShownSpinner(true);
      }, spinnerDelayMs);
      return () => {
        if (spinnerTimerRef.current) {
          clearTimeout(spinnerTimerRef.current);
          spinnerTimerRef.current = null;
        }
      };
    }
    setShowSpinnerAfterDelay(false);
    return undefined;
  }, [isLoading, spinnerDelayMs]);

  /* Reset hadShownSpinner when we transition to showing empty state */
  useEffect(() => {
    if (!isLoading && isEmpty && showEmptyState) {
      setHadShownSpinner(false);
    }
  }, [isLoading, isEmpty, showEmptyState]);

  /* Empty state delay */
  useEffect(() => {
    if (isLoading) {
      if (emptyTimerRef.current) {
        clearTimeout(emptyTimerRef.current);
        emptyTimerRef.current = null;
      }
      setShowEmptyState(false);
      return;
    }

    if (!isEmpty) {
      if (emptyTimerRef.current) {
        clearTimeout(emptyTimerRef.current);
        emptyTimerRef.current = null;
      }
      setShowEmptyState(false);
      return;
    }

    // Fetch completed with empty data: wait delayMs before showing empty state
    emptyTimerRef.current = setTimeout(() => {
      emptyTimerRef.current = null;
      setShowEmptyState(true);
    }, delayMs);

    return () => {
      if (emptyTimerRef.current) {
        clearTimeout(emptyTimerRef.current);
        emptyTimerRef.current = null;
      }
    };
  }, [isLoading, isEmpty, delayMs]);

  /* During delay after empty fetch, keep showing spinner only if we had shown it during load */
  const inEmptyDelay = !isLoading && isEmpty && !showEmptyState;

  return {
    showSpinner: (isLoading && showSpinnerAfterDelay) || (inEmptyDelay && hadShownSpinner),
    showEmptyState: !isLoading && isEmpty && showEmptyState,
  };
}
