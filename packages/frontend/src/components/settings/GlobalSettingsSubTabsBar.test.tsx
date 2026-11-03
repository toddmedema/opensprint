import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GlobalSettingsSubTabsBar } from "./GlobalSettingsSubTabsBar";
import { SettingsSubTabsBar } from "./SettingsSubTabsBar";
import { NAVBAR_HEIGHT } from "../../lib/constants";

describe("GlobalSettingsSubTabsBar", () => {
  it("uses a navbar-height shell with room for project tabs to wrap", () => {
    const { container: globalContainer, unmount: unmountGlobal } = render(
      <GlobalSettingsSubTabsBar activeTab="general" onTabChange={vi.fn()} />
    );
    const globalBar = globalContainer.firstElementChild as HTMLElement;
    expect(globalBar).toHaveAttribute("data-testid", "global-settings-sub-tabs-bar");
    expect(globalBar).toHaveStyle({ height: `${NAVBAR_HEIGHT}px` });
    expect(globalBar.children.length).toBeGreaterThanOrEqual(1);
    unmountGlobal();

    const { container: projectContainer } = render(
      <SettingsSubTabsBar activeTab="basics" onTabChange={vi.fn()} />
    );
    const projectBar = projectContainer.firstElementChild as HTMLElement;
    expect(projectBar).toHaveAttribute("data-testid", "settings-sub-tabs-bar");
    expect(projectBar).toHaveStyle({ minHeight: `${NAVBAR_HEIGHT}px` });
    expect(projectBar.children.length).toBeGreaterThanOrEqual(1);
  });

  it("calls onTabChange when a tab is clicked", async () => {
    const onTabChange = vi.fn();
    const user = userEvent.setup();
    render(<GlobalSettingsSubTabsBar activeTab="general" onTabChange={onTabChange} />);

    await user.click(screen.getByTestId("global-settings-tab-agents"));
    expect(onTabChange).toHaveBeenCalledWith("agents");
  });
});
