import { useState, useEffect } from "react";
import { Layout } from "../components/layout/Layout";
import { GlobalSettingsContent } from "../components/GlobalSettingsContent";
import { SettingsTopBar } from "../components/settings/SettingsTopBar";
import type { SaveStatus } from "../components/SaveIndicator";

/**
 * Full-screen Settings page (homepage). Replaces the DisplaySettingsModal.
 * Uses hierarchical navigation: second-level bar (Global | Project), no "Settings" header.
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
      <div
        className="flex-1 min-h-0 flex flex-col overflow-hidden"
        data-testid="settings-page"
      >
        <SettingsTopBar saveStatus={saveStatus} />
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className="flex-1 min-h-0 overflow-y-auto max-w-[1800px] mx-auto w-full bg-theme-surface px-4 sm:px-6 pt-[15px] pb-6 sm:pb-8">
            <GlobalSettingsContent onSaveStateChange={setSaveStatus} />
          </div>
        </div>
      </div>
    </Layout>
  );
}
