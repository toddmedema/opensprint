/**
 * GitHub Issues provider adapter.
 * Uses the GitHub REST API with a personal access token (PAT) or OAuth app token.
 */

import type { IntegrationConnection, IntegrationSourceOption } from "@opensprint/shared";
import type {
  IntegrationAdapter,
  AdapterCapabilities,
  RawExternalItem,
  NormalizedIntakeItem,
} from "../integration-adapter.js";
import { adapterRegistry } from "../integration-adapter.js";
import { githubRequest, githubRepoPath } from "../github-api.js";
const PAGE_SIZE = 100;

interface GHRepo {
  id: number;
  full_name: string;
  open_issues_count?: number;
}
interface GHIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  user: { login: string } | null;
  labels: { name: string }[];
  created_at: string;
  html_url: string;
  pull_request?: unknown;
}

export class GitHubAdapter implements IntegrationAdapter {
  readonly provider = "github" as const;
  readonly capabilities: AdapterCapabilities = {
    supportsOAuth: false,
    supportsPoll: true,
    supportsWebhook: false,
    supportsSourceSelection: true,
    supportsDelete: false,
  };

  async listSources(
    _connection: IntegrationConnection,
    decryptedToken: string
  ): Promise<IntegrationSourceOption[]> {
    const sources: IntegrationSourceOption[] = [];
    for (let page = 1; ; page++) {
      const repos = await githubRequest<GHRepo[]>(
        `/user/repos?sort=full_name&per_page=${PAGE_SIZE}&type=all&page=${page}`,
        decryptedToken
      );
      sources.push(
        ...repos.map((r) => ({
          id: String(r.id),
          name: r.full_name,
          itemCount: r.open_issues_count,
        }))
      );
      if (repos.length < PAGE_SIZE) return sources;
    }
  }

  async fetchItems(
    connection: IntegrationConnection,
    decryptedToken: string
  ): Promise<RawExternalItem[]> {
    const repoFullName = connection.provider_resource_name;
    if (!repoFullName) return [];

    const path = githubRepoPath(repoFullName);
    const items: RawExternalItem[] = [];
    for (let page = 1; ; page++) {
      const issues = await githubRequest<GHIssue[]>(
        `/repos/${path}/issues?state=open&sort=created&direction=asc&per_page=${PAGE_SIZE}&page=${page}`,
        decryptedToken
      );
      items.push(
        ...issues
          .filter((i) => !i.pull_request)
          .map((issue) => ({
            externalId: String(issue.id),
            title: issue.title,
            body: issue.body ?? undefined,
            author: issue.user?.login,
            labels: issue.labels.map((l) => l.name),
            createdAt: issue.created_at,
            sourceRef: issue.html_url,
            rawPayload: {
              id: String(issue.id),
              number: issue.number,
              repository:
                issue.html_url.match(
                  /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/\d+$/
                )?.[1] ?? repoFullName,
              url: issue.html_url,
            },
          }))
      );
      if (issues.length < PAGE_SIZE) return items;
    }
  }

  normalizeItem(raw: RawExternalItem): NormalizedIntakeItem {
    return {
      external_item_id: raw.externalId,
      title: raw.title,
      body: raw.body ?? null,
      author: raw.author ?? null,
      labels: raw.labels ?? [],
      source_ref: raw.sourceRef ?? null,
      external_created_at: raw.createdAt ?? null,
    };
  }
}

export const githubAdapter = new GitHubAdapter();
adapterRegistry.register(githubAdapter);
