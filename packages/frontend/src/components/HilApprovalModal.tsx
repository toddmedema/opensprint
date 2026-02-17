import type { HilRequestEvent, HilOption } from "@opensprint/shared";

const CATEGORY_LABELS: Record<string, string> = {
  scopeChanges: "Scope Changes",
  architectureDecisions: "Architecture Decisions",
  dependencyModifications: "Dependency Modifications",
};

interface HilApprovalModalProps {
  request: HilRequestEvent;
  onRespond: (requestId: string, approved: boolean, notes?: string) => void;
}

const SECTION_LABELS: Record<string, string> = {
  executive_summary: "Executive Summary",
  problem_statement: "Problem Statement",
  user_personas: "User Personas",
  goals_and_metrics: "Goals & Metrics",
  feature_list: "Feature List",
  technical_architecture: "Technical Architecture",
  data_model: "Data Model",
  api_contracts: "API Contracts",
  non_functional_requirements: "Non-Functional Requirements",
  open_questions: "Open Questions",
};

export function HilApprovalModal({ request, onRespond }: HilApprovalModalProps) {
  const categoryLabel = CATEGORY_LABELS[request.category] ?? request.category;
  const isScopeChange = request.category === "scopeChanges";
  const hasSummary =
    isScopeChange &&
    (request.scopeChangeSummary || (request.scopeChangeProposedUpdates && request.scopeChangeProposedUpdates.length > 0));

  const handleOption = (option: HilOption) => {
    const approved = option.id === "approve" || option.id === "retry";
    onRespond(request.requestId, approved);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        className={`mx-4 w-full rounded-lg bg-white shadow-xl ${
          hasSummary ? "max-w-3xl max-h-[90vh] overflow-hidden flex flex-col" : "max-w-md"
        } p-6`}
      >
        <h3 className="text-lg font-semibold text-gray-900">
          Approval required: {categoryLabel}
        </h3>
        <p className="mt-2 text-sm text-gray-600">{request.description}</p>

        {hasSummary && (
          <div className="mt-4 flex-1 min-h-0 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-4">
            <h4 className="text-sm font-medium text-gray-700">Proposed PRD changes</h4>
            {request.scopeChangeSummary ? (
              <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-gray-800">
                {request.scopeChangeSummary}
              </pre>
            ) : (
              <ul className="mt-2 space-y-2">
                {request.scopeChangeProposedUpdates?.map((u) => (
                  <li key={u.section} className="text-sm text-gray-800">
                    <span className="font-medium">
                      {SECTION_LABELS[u.section] ?? u.section.replace(/_/g, " ")}
                    </span>
                    {u.changeLogEntry && (
                      <span className="text-gray-600"> — {u.changeLogEntry}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className={`flex flex-col gap-2 ${hasSummary ? "mt-4 shrink-0" : "mt-4"}`}>
          {request.options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => handleOption(option)}
              className={`rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors ${
                option.id === "approve" || option.id === "retry"
                  ? "border-green-300 bg-green-50 text-green-800 hover:bg-green-100"
                  : "border-gray-200 bg-gray-50 text-gray-800 hover:bg-gray-100"
              }`}
            >
              <span className="block">{option.label}</span>
              {option.description && (
                <span className="mt-0.5 block text-xs font-normal text-gray-500">
                  {option.description}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
