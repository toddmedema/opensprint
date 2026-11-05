/** GitHub requests stay on the configured API origin and never expose upstream bodies. */
export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly rateLimited = false
  ) {
    super(
      rateLimited
        ? "GitHub rate limit reached. Please try again later."
        : `GitHub API request failed (${status}). Check repository access and token permissions.`
    );
  }

  get needsReconnect(): boolean {
    return this.status === 401 || (this.status === 403 && !this.rateLimited);
  }
}

export async function githubRequest<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const rateLimited =
      response.status === 429 ||
      response.headers?.get("x-ratelimit-remaining") === "0" ||
      !!response.headers?.get("retry-after");
    throw new GitHubApiError(response.status, rateLimited);
  }
  return (await response.json()) as T;
}

export function githubRepoPath(repository: string): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("Invalid GitHub repository. Select an owner/repository.");
  }
  return repository.split("/").map(encodeURIComponent).join("/");
}
