import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTaskFilter } from "./useTaskFilter";

const EXECUTE_STATUS_FILTER_KEY = "opensprint.executeStatusFilter";

describe("useTaskFilter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.removeItem(EXECUTE_STATUS_FILTER_KEY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns default state", () => {
    const { result } = renderHook(() => useTaskFilter());

    expect(result.current.statusFilter).toBe("all");
    expect(result.current.searchExpanded).toBe(false);
    expect(result.current.searchInputValue).toBe("");
    expect(result.current.searchQuery).toBe("");
    expect(result.current.isSearchActive).toBe(false);
  });

  it("updates statusFilter when setStatusFilter is called", () => {
    const { result } = renderHook(() => useTaskFilter());

    act(() => {
      result.current.setStatusFilter("done");
    });

    expect(result.current.statusFilter).toBe("done");
  });

  it("accepts planning as valid statusFilter", () => {
    const { result } = renderHook(() => useTaskFilter());
    act(() => result.current.setStatusFilter("planning"));
    expect(result.current.statusFilter).toBe("planning");
  });

  it("expands search when handleSearchExpand is called", () => {
    const { result } = renderHook(() => useTaskFilter());

    act(() => {
      result.current.handleSearchExpand();
    });

    expect(result.current.searchExpanded).toBe(true);
  });

  it("closes and clears search when handleSearchClose is called", () => {
    const { result } = renderHook(() => useTaskFilter());

    act(() => {
      result.current.setSearchInputValue("foo");
      result.current.handleSearchExpand();
    });

    act(() => {
      result.current.handleSearchClose();
    });

    expect(result.current.searchExpanded).toBe(false);
    expect(result.current.searchInputValue).toBe("");
    expect(result.current.searchQuery).toBe("");
  });

  it("debounces search query from input value", () => {
    const { result } = renderHook(() => useTaskFilter());

    act(() => {
      result.current.setSearchInputValue("login");
    });

    expect(result.current.searchQuery).toBe("");

    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(result.current.searchQuery).toBe("login");
    expect(result.current.isSearchActive).toBe(true);
  });

  it("persists status filter to localStorage when setStatusFilter is called", () => {
    const { result } = renderHook(() => useTaskFilter());

    act(() => {
      result.current.setStatusFilter("in_line");
    });

    expect(result.current.statusFilter).toBe("in_line");
    expect(localStorage.getItem(EXECUTE_STATUS_FILTER_KEY)).toBe("in_line");
  });

  it("restores status filter from localStorage on mount", () => {
    localStorage.setItem(EXECUTE_STATUS_FILTER_KEY, "ready");
    const { result } = renderHook(() => useTaskFilter());

    expect(result.current.statusFilter).toBe("ready");
  });

  it("migrates in_review from localStorage to in_progress on mount", () => {
    localStorage.setItem(EXECUTE_STATUS_FILTER_KEY, "in_review");
    const { result } = renderHook(() => useTaskFilter());

    expect(result.current.statusFilter).toBe("in_progress");
  });

  it("clears search query immediately when input is empty", () => {
    const { result } = renderHook(() => useTaskFilter());

    act(() => {
      result.current.setSearchInputValue("foo");
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current.searchQuery).toBe("foo");

    act(() => {
      result.current.setSearchInputValue("");
    });

    expect(result.current.searchQuery).toBe("");
  });
});
