import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { FolderBrowser } from "./FolderBrowser";

vi.mock("../api/client", () => ({
  api: { filesystem: { browse: vi.fn(), createFolder: vi.fn() } },
}));
const home = {
  current: "/Users/sample",
  parent: null,
  entries: [{ name: "Projects", path: "/Users/sample/Projects", isDirectory: true }],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.filesystem.browse).mockResolvedValue(home);
});

describe("FolderBrowser", () => {
  it("uses the server default and selects the displayed folder without repeating its path", async () => {
    const onSelect = vi.fn();
    render(<FolderBrowser onSelect={onSelect} onCancel={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Select", exact: true })).toBeEnabled()
    );
    expect(api.filesystem.browse).toHaveBeenCalledWith(undefined);
    expect(screen.getByRole("textbox", { name: "Folder path" })).toHaveValue(home.current);
    expect(screen.queryByText(home.current)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "..", exact: true })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Select", exact: true }));
    expect(onSelect).toHaveBeenCalledWith(home.current);
  });

  it("disables selection until the initial folder has loaded", async () => {
    let finish!: (value: typeof home) => void;
    vi.mocked(api.filesystem.browse).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    render(<FolderBrowser initialPath={home.current} onSelect={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Select", exact: true })).toBeDisabled();
    await act(async () => finish(home));
    expect(screen.getByRole("button", { name: "Select", exact: true })).toBeEnabled();
  });

  it("does not select a stale directory after failed navigation, and recovers on valid navigation", async () => {
    const onSelect = vi.fn();
    render(<FolderBrowser onSelect={onSelect} onCancel={vi.fn()} />);
    await screen.findByDisplayValue(home.current);
    vi.mocked(api.filesystem.browse).mockRejectedValueOnce(
      new Error("Path is outside the allowed directory.")
    );
    const pathInput = screen.getByRole("textbox", { name: "Folder path" });
    await userEvent.clear(pathInput);
    await userEvent.type(pathInput, "/outside{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Path is outside the allowed directory."
    );
    await userEvent.click(screen.getByRole("button", { name: "Select", exact: true }));
    expect(onSelect).not.toHaveBeenCalled();
    vi.mocked(api.filesystem.browse).mockResolvedValueOnce({
      current: home.entries[0].path,
      parent: home.current,
      entries: [],
    });
    await userEvent.click(screen.getByRole("button", { name: "Projects" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Select", exact: true })).toBeEnabled()
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores stale browse failures when a newer initial directory has loaded", async () => {
    let fail!: (error: Error) => void;
    vi.mocked(api.filesystem.browse).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        fail = reject;
      })
    );
    const props = { onSelect: vi.fn(), onCancel: vi.fn() };
    const { rerender } = render(<FolderBrowser initialPath="/old" {...props} />);
    rerender(<FolderBrowser initialPath={home.current} {...props} />);
    await screen.findByDisplayValue(home.current);
    await act(async () => fail(new Error("Old directory failed")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select", exact: true })).toBeEnabled();
  });
});
