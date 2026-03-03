import { useState, useEffect, useRef, useCallback } from "react";
import type { StatusFilter } from "../lib/executeTaskFilter";

const SEARCH_DEBOUNCE_MS = 150;
const EXECUTE_STATUS_FILTER_KEY = "opensprint.executeStatusFilter";

const VALID_STATUS_FILTERS: StatusFilter[] = [
  "all",
  "in_line",
  "ready",
  "in_progress",
  "done",
  "blocked",
];

function loadStatusFilter(): StatusFilter {
  if (typeof window === "undefined") return "all";
  try {
    const stored = localStorage.getItem(EXECUTE_STATUS_FILTER_KEY);
    if (!stored) return "all";
    if (stored === "in_review") return "in_progress";
    if (VALID_STATUS_FILTERS.includes(stored as StatusFilter)) {
      return stored as StatusFilter;
    }
  } catch {
    // ignore
  }
  return "all";
}

function saveStatusFilter(value: StatusFilter): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(EXECUTE_STATUS_FILTER_KEY, value);
  } catch {
    // ignore
  }
}

export function useTaskFilter() {
  const [statusFilter, setStatusFilterState] = useState<StatusFilter>(loadStatusFilter);

  const setStatusFilter = useCallback((value: StatusFilter) => {
    setStatusFilterState(value);
    saveStatusFilter(value);
  }, []);
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [searchInputValue, setSearchInputValue] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (searchExpanded) {
      searchInputRef.current?.focus();
    }
  }, [searchExpanded]);

  useEffect(() => {
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    if (searchInputValue === "") {
      setSearchQuery("");
      return;
    }
    const id = setTimeout(() => {
      searchDebounceRef.current = null;
      setSearchQuery(searchInputValue);
    }, SEARCH_DEBOUNCE_MS);
    searchDebounceRef.current = id;
    return () => {
      clearTimeout(id);
      if (searchDebounceRef.current === id) searchDebounceRef.current = null;
    };
  }, [searchInputValue]);

  const handleSearchExpand = () => {
    setSearchExpanded(true);
  };

  const handleSearchClose = useCallback(() => {
    setSearchInputValue("");
    setSearchQuery("");
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    searchInputRef.current?.blur();
    setSearchExpanded(false);
  }, []);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      handleSearchClose();
    }
  };

  const isSearchActive = searchQuery.trim().length > 0;

  return {
    statusFilter,
    setStatusFilter,
    searchExpanded,
    searchInputValue,
    setSearchInputValue,
    searchQuery,
    searchInputRef,
    isSearchActive,
    handleSearchExpand,
    handleSearchClose,
    handleSearchKeyDown,
  };
}
