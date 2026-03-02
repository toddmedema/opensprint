import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  usePhaseLoadingState,
  PHASE_EMPTY_DELAY_MS,
  PHASE_SPINNER_DELAY_MS,
} from "./usePhaseLoadingState";

describe("usePhaseLoadingState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns showSpinner true when isLoading (after 300ms delay to avoid flash)", () => {
    const { result } = renderHook(() => usePhaseLoadingState(true, false));
    expect(result.current.showSpinner).toBe(false);
    act(() => {
      vi.advanceTimersByTime(PHASE_SPINNER_DELAY_MS);
    });
    expect(result.current.showSpinner).toBe(true);
    expect(result.current.showEmptyState).toBe(false);
  });

  it("returns showSpinner false and showEmptyState false when loaded with data", () => {
    const { result } = renderHook(() => usePhaseLoadingState(false, false));
    expect(result.current.showSpinner).toBe(false);
    expect(result.current.showEmptyState).toBe(false);
  });

  it("shows spinner during fetch and 300ms delay before empty state when loaded empty", () => {
    const { result, rerender } = renderHook(
      ({ isLoading, isEmpty }) => usePhaseLoadingState(isLoading, isEmpty),
      { initialProps: { isLoading: true, isEmpty: true } }
    );

    expect(result.current.showSpinner).toBe(false);
    act(() => {
      vi.advanceTimersByTime(PHASE_SPINNER_DELAY_MS);
    });
    expect(result.current.showSpinner).toBe(true);
    expect(result.current.showEmptyState).toBe(false);

    rerender({ isLoading: false, isEmpty: true });

    expect(result.current.showSpinner).toBe(true);
    expect(result.current.showEmptyState).toBe(false);

    act(() => {
      vi.advanceTimersByTime(PHASE_EMPTY_DELAY_MS);
    });

    expect(result.current.showSpinner).toBe(false);
    expect(result.current.showEmptyState).toBe(true);
  });

  it("cancels empty state when data arrives before delay", () => {
    const { result, rerender } = renderHook(
      ({ isLoading, isEmpty }) => usePhaseLoadingState(isLoading, isEmpty),
      { initialProps: { isLoading: false, isEmpty: true } }
    );

    act(() => {
      vi.advanceTimersByTime(PHASE_EMPTY_DELAY_MS - 50);
    });

    rerender({ isLoading: false, isEmpty: false });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.showSpinner).toBe(false);
    expect(result.current.showEmptyState).toBe(false);
  });
});
