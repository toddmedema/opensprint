import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsSubTabsBar, SETTINGS_SUB_TABS } from "./SettingsSubTabsBar";

describe("SettingsSubTabsBar", () => {
  it("renders all tabs including Integrations", () => {
    render(<SettingsSubTabsBar activeTab="basics" onTabChange={vi.fn()} />);

    expect(screen.getByText("Project Info")).toBeInTheDocument();
    expect(screen.getByText("Agent Config")).toBeInTheDocument();
    expect(screen.getByText("Workflow")).toBeInTheDocument();
    expect(screen.getByText("Review governance")).toBeInTheDocument();
    expect(screen.getByText("Deliver")).toBeInTheDocument();
    expect(screen.getByText("Autonomy")).toBeInTheDocument();
    expect(screen.getByText("Team")).toBeInTheDocument();
    expect(screen.getByText("Integrations")).toBeInTheDocument();
  });

  it("includes integrations in the TABS export", () => {
    const keys = SETTINGS_SUB_TABS.map((t) => t.key);
    expect(keys).toContain("integrations");
  });

  it("integrations tab appears after team", () => {
    const keys = SETTINGS_SUB_TABS.map((t) => t.key);
    const teamIdx = keys.indexOf("team");
    const intIdx = keys.indexOf("integrations");
    expect(intIdx).toBeGreaterThan(teamIdx);
  });

  it("calls onTabChange with integrations when clicked", async () => {
    const onTabChange = vi.fn();
    const user = userEvent.setup();
    render(<SettingsSubTabsBar activeTab="basics" onTabChange={onTabChange} />);

    await user.click(screen.getByTestId("settings-tab-integrations"));
    expect(onTabChange).toHaveBeenCalledWith("integrations");
  });

  it("marks integrations tab as active when activeTab is integrations", () => {
    render(<SettingsSubTabsBar activeTab="integrations" onTabChange={vi.fn()} />);

    const intButton = screen.getByTestId("settings-tab-integrations");
    expect(intButton).toHaveAttribute("data-active", "true");
  });
});
