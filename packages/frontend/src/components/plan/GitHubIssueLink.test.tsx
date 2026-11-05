import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GitHubIssueLink } from "./GitHubIssueLink";

const issue = {
  id: "123",
  number: 42,
  repository: "octocat/hello-world",
  url: "https://github.com/octocat/hello-world/issues/42",
};

describe("GitHubIssueLink", () => {
  it("shows the original issue with a compact label", () => {
    render(<GitHubIssueLink issue={issue} compact />);
    expect(screen.getByRole("link")).toHaveTextContent("GitHub #42");
    expect(screen.getByRole("link")).toHaveAttribute("href", issue.url);
    expect(screen.getByRole("link")).toHaveAttribute("target", "_blank");
  });

  it.each([
    undefined,
    { ...issue, url: "javascript:alert(1)" },
    { ...issue, url: "https://github.com.evil.example/issues/42" },
    { ...issue, url: "https://github.com@evil.example/issues/42" },
    { ...issue, repository: "octocat/hello-world/../../evil" },
    { ...issue, number: -1 },
    { ...issue, url: "https://github.com/other/repo/issues/42" },
  ])("does not render an invalid source link", (source) => {
    render(<GitHubIssueLink issue={source} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
