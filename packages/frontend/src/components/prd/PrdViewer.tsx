import { formatSectionKey } from "../../lib/formatting";
import { getOrderedSections } from "../../lib/prdUtils";
import { PrdSectionEditor } from "./PrdSectionEditor";

export interface PrdViewerProps {
  prdContent: Record<string, string>;
  savingSections: string[];
  onSectionChange: (section: string, markdown: string) => void;
  containerRef?: React.RefObject<HTMLDivElement | null>;
}

export function PrdViewer({
  prdContent,
  savingSections,
  onSectionChange,
  containerRef,
}: PrdViewerProps) {
  return (
    <div ref={containerRef}>
      {/* PRD Sections - always editable inline */}
      <div className="space-y-8">
        {getOrderedSections(prdContent).map((sectionKey) => (
          <div
            key={sectionKey}
            data-prd-section={sectionKey}
            className="group relative"
          >
            {/* Section header */}
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-gray-800">
                {formatSectionKey(sectionKey)}
              </h2>
              {savingSections.includes(sectionKey) && (
                <span className="text-xs text-gray-500">Saving...</span>
              )}
            </div>

            {/* Section content - inline WYSIWYG editor */}
            <PrdSectionEditor
              sectionKey={sectionKey}
              markdown={prdContent[sectionKey] ?? ""}
              onSave={onSectionChange}
              disabled={savingSections.includes(sectionKey)}
            />

            {/* Divider */}
            <div className="mt-8 border-b border-gray-100" />
          </div>
        ))}
      </div>
    </div>
  );
}
