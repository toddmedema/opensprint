import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronLeftIcon, ChevronRightIcon, ListIcon } from "../icons/PrdIcons";
import { formatSectionKey } from "../../lib/formatting";
import { getOrderedSections } from "../../lib/prdUtils";

/** Offset from top of viewport to consider a section "active" (px) */
const ACTIVE_SECTION_TOP_OFFSET = 120;

export interface PrdTocPanelProps {
  prdContent: Record<string, string>;
  /** Ref to the scroll container (PRD content area). Used for IntersectionObserver root. */
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** When expanded: parent may wrap in ResizableSidebar */
  resizable?: boolean;
}

/**
 * Collapsible table of contents for the PRD. When expanded: shows section titles with
 * resize handle. When collapsed: shows only section numbers. Bold indicates active section.
 */
export function PrdTocPanel({
  prdContent,
  scrollContainerRef,
  collapsed,
  onCollapsedChange,
  resizable = false,
}: PrdTocPanelProps) {
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const visibleSectionsRef = useRef<Map<string, { top: number; ratio: number }>>(new Map());

  const sections = getOrderedSections(prdContent);

  /* ── IntersectionObserver: detect which section is in view ── */
  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    if (!scrollEl || sections.length === 0) return;

    const sectionElements = scrollEl.querySelectorAll<HTMLElement>("[data-prd-section]");
    if (sectionElements.length === 0) return;

    const updateActiveSection = () => {
      const entries = Array.from(visibleSectionsRef.current.entries());
      if (entries.length === 0) {
        setActiveSection((prev) => (prev && sections.includes(prev) ? prev : sections[0] ?? null));
        return;
      }
      const rootRect = scrollEl.getBoundingClientRect();
      const targetTop = rootRect.top + ACTIVE_SECTION_TOP_OFFSET;
      const sorted = entries
        .filter(([, v]) => v.ratio > 0)
        .sort((a, b) => {
          const aDist = Math.abs(a[1].top - targetTop);
          const bDist = Math.abs(b[1].top - targetTop);
          return aDist - bDist;
        });
      const next = sorted[0]?.[0] ?? null;
      setActiveSection(next);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.prdSection;
          if (!key) continue;
          const rect = entry.boundingClientRect;
          const rootRect = entry.rootBounds;
          if (entry.isIntersecting && rootRect) {
            visibleSectionsRef.current.set(key, { top: rect.top, ratio: entry.intersectionRatio });
          } else {
            visibleSectionsRef.current.delete(key);
          }
        }
        updateActiveSection();
      },
      {
        root: scrollEl,
        rootMargin: "0px",
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
      }
    );

    sectionElements.forEach((el) => observer.observe(el));
    observerRef.current = observer;

    const handleScroll = () => {
      requestAnimationFrame(updateActiveSection);
    };
    scrollEl.addEventListener("scroll", handleScroll, { passive: true });
    updateActiveSection();

    return () => {
      observer.disconnect();
      observerRef.current = null;
      scrollEl.removeEventListener("scroll", handleScroll);
      visibleSectionsRef.current.clear();
    };
  }, [prdContent, scrollContainerRef, sections]);

  const scrollToSection = useCallback(
    (sectionKey: string) => {
      const scrollEl = scrollContainerRef.current;
      if (!scrollEl) return;
      const el = scrollEl.querySelector<HTMLElement>(`[data-prd-section="${sectionKey}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },
    [scrollContainerRef]
  );

  const widthClass = collapsed
    ? "w-12 min-w-[48px] items-center justify-start pt-3"
    : resizable
      ? "w-full min-w-0"
      : "w-[220px] min-w-[180px]";
  const borderClass = resizable && !collapsed ? "" : "border-r border-theme-border";
  const containerClass = `flex flex-col h-full min-h-0 bg-theme-bg shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${borderClass} ${widthClass}`;

  return (
    <div className={containerClass} data-testid="prd-toc-sidebar">
      {collapsed ? (
        <button
          type="button"
          onClick={() => onCollapsedChange(false)}
          className="flex flex-col items-center gap-1 p-2 shrink-0 text-theme-muted hover:text-brand-600 dark:hover:text-brand-400 hover:bg-theme-border-subtle rounded-lg transition-colors"
          title="Expand table of contents"
          aria-label="Expand table of contents"
        >
          <ListIcon className="w-5 h-5" />
          <ChevronRightIcon className="w-4 h-4" />
        </button>
      ) : (
        <>
          <div
            className="flex items-center justify-between px-3 py-3 border-b border-theme-border bg-theme-bg shrink-0 sticky top-0 z-10"
            data-testid="prd-toc-header"
          >
            <span className="text-sm font-semibold text-theme-text">Contents</span>
            <button
              type="button"
              onClick={() => onCollapsedChange(true)}
              className="p-1.5 rounded-full hover:bg-theme-border-subtle text-theme-muted hover:text-theme-text transition-colors"
              title="Collapse table of contents"
              aria-label="Collapse table of contents"
            >
              <ChevronLeftIcon className="w-4 h-4" />
            </button>
          </div>

          <nav
            className="flex-1 overflow-y-auto p-3 space-y-1"
            aria-label="Table of contents"
          >
            {sections.map((sectionKey, index) => {
              const isActive = activeSection === sectionKey;
              return (
                <button
                  key={sectionKey}
                  type="button"
                  onClick={() => scrollToSection(sectionKey)}
                  className={`w-full text-left px-2 py-1.5 rounded-lg text-sm transition-colors block truncate ${
                    isActive
                      ? "font-bold text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/30"
                      : "text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle"
                  }`}
                  data-testid={`toc-section-${sectionKey}`}
                  data-active={isActive}
                >
                  <span className="text-theme-muted font-medium mr-1.5">{index + 1}.</span>
                  {formatSectionKey(sectionKey)}
                </button>
              );
            })}
          </nav>
        </>
      )}

      {/* Collapsed: section numbers only */}
      {collapsed && sections.length > 0 && (
        <div className="flex-1 overflow-y-auto py-2 flex flex-col items-center gap-0.5">
          {sections.map((sectionKey, index) => {
            const isActive = activeSection === sectionKey;
            return (
              <button
                key={sectionKey}
                type="button"
                onClick={() => scrollToSection(sectionKey)}
                title={formatSectionKey(sectionKey)}
                className={`w-8 h-8 flex items-center justify-center rounded-lg text-xs transition-colors ${
                  isActive
                    ? "font-bold text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/30"
                    : "text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle"
                }`}
                data-testid={`toc-section-${sectionKey}`}
                data-active={isActive}
              >
                {index + 1}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
