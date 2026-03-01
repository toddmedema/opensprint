import { useState, useEffect } from "react";
import { Layout } from "../components/layout/Layout";
import { GlobalSettingsContent } from "../components/GlobalSettingsContent";
import { SaveIndicator, type SaveStatus } from "../components/SaveIndicator";

/**
 * Full-screen Settings page (homepage). Replaces the DisplaySettingsModal.
 */
export function SettingsPage() {
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");

  useEffect(() => {
    if (saveStatus !== "saving") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveStatus]);

  return (
    <Layout>
      <div className="flex-1 min-h-0 overflow-y-auto" data-testid="settings-page">
        <div className="max-w-2xl mx-auto px-6 py-8">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-semibold text-theme-text">Settings</h1>
            <SaveIndicator status={saveStatus} data-testid="settings-save-indicator" />
          </div>
          <div className="bg-theme-surface rounded-xl border border-theme-border p-6">
            <GlobalSettingsContent onSaveStateChange={setSaveStatus} />
          </div>
        </div>
      </div>
    </Layout>
  );
}
