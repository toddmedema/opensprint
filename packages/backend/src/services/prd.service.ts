import fs from "fs/promises";
import path from "path";
import type { Prd, PrdSection, PrdChangeLogEntry, PrdSectionKey } from "@opensprint/shared";
import {
  OPENSPRINT_PATHS,
  SPEC_MD,
  SPEC_METADATA_PATH,
  prdToSpecMarkdown,
  specMarkdownToPrd,
} from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { gitCommitQueue } from "./git-commit-queue.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { writeJsonAtomic } from "../utils/file-utils.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("prd.service");

const PRD_SECTION_KEYS: PrdSectionKey[] = [
  "executive_summary",
  "problem_statement",
  "user_personas",
  "goals_and_metrics",
  "feature_list",
  "technical_architecture",
  "data_model",
  "api_contracts",
  "non_functional_requirements",
  "open_questions",
];

/** Valid section key format for Sketch agent dynamic sections (snake_case). */
const SECTION_KEY_FORMAT = /^[a-z][a-z0-9_]*$/;

function emptySection(): PrdSection {
  return { content: "", version: 0, updatedAt: new Date().toISOString() };
}

function createEmptyPrd(): Prd {
  return {
    version: 0,
    sections: {
      executive_summary: emptySection(),
      problem_statement: emptySection(),
      user_personas: emptySection(),
      goals_and_metrics: emptySection(),
      feature_list: emptySection(),
      technical_architecture: emptySection(),
      data_model: emptySection(),
      api_contracts: emptySection(),
      non_functional_requirements: emptySection(),
      open_questions: emptySection(),
    },
    changeLog: [],
  };
}

export class PrdService {
  private projectService = new ProjectService();

  /**
   * Get the file path for a project's SPEC.md (Sketch phase output at repo root).
   * PRD is always written to the PROJECT's repo (project.repoPath from project index).
   */
  private async getSpecPath(projectId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    return path.join(project.repoPath, SPEC_MD);
  }

  private async getSpecMetadataPath(projectId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    return path.join(project.repoPath, SPEC_METADATA_PATH);
  }

  /**
   * Migrate from legacy prd.json or PRD.md to SPEC.md.
   * Returns the migrated Prd or null if no legacy file exists.
   * Exported for use by context-assembler when SPEC.md is missing.
   */
  async migrateFromLegacy(repoPath: string): Promise<Prd | null> {
    const prdJsonPath = path.join(repoPath, OPENSPRINT_PATHS.prd);
    const prdMdPath = path.join(repoPath, "PRD.md");
    const specPath = path.join(repoPath, SPEC_MD);

    try {
      const prdJsonStat = await fs.stat(prdJsonPath).catch(() => null);
      if (prdJsonStat?.isFile()) {
        const data = await fs.readFile(prdJsonPath, "utf-8");
        const parsed = JSON.parse(data) as Prd;
        if (!Array.isArray(parsed.changeLog)) parsed.changeLog = [];
        const markdown = prdToSpecMarkdown(parsed);
        await fs.writeFile(specPath, markdown, "utf-8");
        const metaPath = path.join(repoPath, path.dirname(SPEC_METADATA_PATH));
        await fs.mkdir(metaPath, { recursive: true });
        const sectionVersions: Record<string, number> = {};
        for (const [k, s] of Object.entries(parsed.sections || {})) {
          sectionVersions[k] = (s as { version?: number }).version ?? 1;
        }
        await fs.writeFile(
          path.join(repoPath, SPEC_METADATA_PATH),
          JSON.stringify(
            { version: parsed.version, changeLog: parsed.changeLog, sectionVersions },
            null,
            2
          ),
          "utf-8"
        );
        await fs.unlink(prdJsonPath).catch(() => {});
        log.info("Migrated prd.json to SPEC.md", { repoPath });
        return parsed;
      }
    } catch {
      /* ignore */
    }

    try {
      const prdMdStat = await fs.stat(prdMdPath).catch(() => null);
      if (prdMdStat?.isFile()) {
        const raw = await fs.readFile(prdMdPath, "utf-8");
        const prd = specMarkdownToPrd(raw);
        const markdown = prdToSpecMarkdown(prd);
        await fs.writeFile(specPath, markdown, "utf-8");
        const metaDir = path.join(repoPath, path.dirname(SPEC_METADATA_PATH));
        await fs.mkdir(metaDir, { recursive: true });
        await fs.writeFile(
          path.join(repoPath, SPEC_METADATA_PATH),
          JSON.stringify({ version: 0, changeLog: [] }, null, 2),
          "utf-8"
        );
        await fs.unlink(prdMdPath).catch(() => {});
        log.info("Migrated PRD.md to SPEC.md", { repoPath });
        return prd;
      }
    } catch {
      /* ignore */
    }

    return null;
  }

  /** Load the PRD from disk (SPEC.md). Migrates from prd.json or PRD.md if present. */
  private async loadPrd(projectId: string): Promise<Prd> {
    const project = await this.projectService.getProject(projectId);
    const specPath = path.join(project.repoPath, SPEC_MD);
    const metaPath = path.join(project.repoPath, SPEC_METADATA_PATH);

    try {
      const markdown = await fs.readFile(specPath, "utf-8");
      let metadata: {
        version: number;
        changeLog: PrdChangeLogEntry[];
        sectionVersions?: Record<string, number>;
      } | undefined;
      try {
        const metaRaw = await fs.readFile(metaPath, "utf-8");
        const meta = JSON.parse(metaRaw) as {
          version?: number;
          changeLog?: PrdChangeLogEntry[];
          sectionVersions?: Record<string, number>;
        };
        metadata = {
          version: meta.version ?? 0,
          changeLog: Array.isArray(meta.changeLog) ? meta.changeLog : [],
          sectionVersions: meta.sectionVersions,
        };
      } catch {
        metadata = undefined;
      }
      const prd = specMarkdownToPrd(markdown, metadata);
      if (metadata?.sectionVersions) {
        for (const [key, ver] of Object.entries(metadata.sectionVersions)) {
          if (prd.sections[key]) prd.sections[key]!.version = ver;
        }
      }
      return prd;
    } catch {
      const migrated = await this.migrateFromLegacy(project.repoPath);
      if (migrated) return migrated;
      throw new AppError(404, ErrorCodes.PRD_NOT_FOUND, "PRD not found for this project");
    }
  }

  /**
   * Load the PRD from disk, or create and persist an empty PRD if the file is missing.
   * Used when applying updates (Sketch Dreamer, generate-from-codebase) so the first
   * PRD_UPDATE blocks are saved even when the project has no SPEC.md yet (e.g. adopted repo).
   */
  private async loadOrCreatePrd(projectId: string): Promise<Prd> {
    try {
      return await this.loadPrd(projectId);
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCodes.PRD_NOT_FOUND) {
        const prd = createEmptyPrd();
        await this.savePrd(projectId, prd);
        return prd;
      }
      throw err;
    }
  }

  /** Save the PRD to disk (SPEC.md + spec-metadata.json) and enqueue git commit */
  private async savePrd(
    projectId: string,
    prd: Prd,
    options?: { source?: PrdChangeLogEntry["source"]; planId?: string }
  ): Promise<void> {
    const project = await this.projectService.getProject(projectId);
    const specPath = path.join(project.repoPath, SPEC_MD);
    const metaPath = path.join(project.repoPath, SPEC_METADATA_PATH);

    const cwd = process.cwd();
    const normalizedRepo = path.resolve(project.repoPath);
    const normalizedCwd = path.resolve(cwd);
    const looksLikeServerRepo =
      normalizedRepo === normalizedCwd &&
      (await fs.stat(path.join(cwd, "packages", "backend")).catch(() => null))?.isDirectory();
    if (looksLikeServerRepo) {
      log.warn(
        "SPEC is being written to the OpenSprint server repo (project repoPath equals server cwd). " +
          "Ensure the dreamer/chat is running in the intended project, not the dev server repo.",
        { projectId, repoPath: project.repoPath }
      );
    }

    const markdown = prdToSpecMarkdown(prd);
    await fs.writeFile(specPath, markdown, "utf-8");
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    const sectionVersions: Record<string, number> = {};
    for (const [k, s] of Object.entries(prd.sections)) {
      sectionVersions[k] = s.version;
    }
    await fs.writeFile(
      metaPath,
      JSON.stringify(
        { version: prd.version, changeLog: prd.changeLog, sectionVersions },
        null,
        2
      ),
      "utf-8"
    );
    const source = options?.source ?? "sketch";
    gitCommitQueue.enqueue({
      type: "prd_update",
      repoPath: project.repoPath,
      source,
      planId: options?.planId,
    });
  }

  /**
   * Validate a section key.
   * @param allowDynamic - When true (Sketch agent), accept any key matching snake_case format.
   *   When false (Harmonizer, etc.), only accept known PRD_SECTION_KEYS.
   */
  private validateSectionKey(key: string, allowDynamic = false): void {
    if (allowDynamic) {
      if (!SECTION_KEY_FORMAT.test(key)) {
        throw new AppError(
          400,
          "INVALID_SECTION",
          `Invalid PRD section key '${key}'. Must be snake_case (e.g. competitive_landscape).`
        );
      }
      return;
    }
    if (!PRD_SECTION_KEYS.includes(key as PrdSectionKey)) {
      throw new AppError(
        400,
        "INVALID_SECTION",
        `Invalid PRD section key '${key}'. Valid keys: ${PRD_SECTION_KEYS.join(", ")}`
      );
    }
  }

  /** Compute a simple diff summary */
  private computeDiff(oldContent: string, newContent: string): string {
    if (!oldContent && newContent) return "[Initial content added]";
    if (oldContent && !newContent) return "[Content removed]";
    if (oldContent === newContent) return "[No changes]";
    const oldLines = oldContent.split("\n").length;
    const newLines = newContent.split("\n").length;
    const lineDelta = newLines - oldLines;
    const charDelta = newContent.length - oldContent.length;
    return `[${lineDelta >= 0 ? "+" : ""}${lineDelta} lines, ${charDelta >= 0 ? "+" : ""}${charDelta} chars]`;
  }

  /** Get the full PRD */
  async getPrd(projectId: string): Promise<Prd> {
    return this.loadPrd(projectId);
  }

  /** Get a specific PRD section (supports dynamic sections added by Sketch agent) */
  async getSection(projectId: string, sectionKey: string): Promise<PrdSection> {
    this.validateSectionKey(sectionKey, true);
    const prd = await this.loadPrd(projectId);
    const section = prd.sections[sectionKey];
    if (!section) {
      throw new AppError(
        404,
        ErrorCodes.SECTION_NOT_FOUND,
        `PRD section '${sectionKey}' not found`,
        { sectionKey }
      );
    }
    return section;
  }

  /** Update a specific PRD section */
  async updateSection(
    projectId: string,
    sectionKey: string,
    content: string,
    source: PrdChangeLogEntry["source"] = "sketch"
  ): Promise<{ section: PrdSection; previousVersion: number; newVersion: number }> {
    this.validateSectionKey(sectionKey, source === "sketch");
    const prd = await this.loadOrCreatePrd(projectId);
    const key = sectionKey;
    const now = new Date().toISOString();

    const existing = prd.sections[key];
    const previousVersion = existing ? existing.version : 0;
    const newVersion = previousVersion + 1;
    const diff = this.computeDiff(existing?.content ?? "", content);

    const updatedSection: PrdSection = {
      content,
      version: newVersion,
      updatedAt: now,
    };

    prd.sections[key] = updatedSection;
    prd.version += 1;

    prd.changeLog.push({
      section: key,
      version: newVersion,
      source,
      timestamp: now,
      diff,
    });

    await this.savePrd(projectId, prd, { source });

    return { section: updatedSection, previousVersion, newVersion };
  }

  /** Update multiple PRD sections at once */
  async updateSections(
    projectId: string,
    updates: Array<{ section: string; content: string }>,
    source: PrdChangeLogEntry["source"] = "sketch"
  ): Promise<Array<{ section: string; previousVersion: number; newVersion: number }>> {
    const prd = await this.loadOrCreatePrd(projectId);
    const changes: Array<{ section: string; previousVersion: number; newVersion: number }> = [];
    const now = new Date().toISOString();
    const allowDynamic = source === "sketch";

    for (const update of updates) {
      this.validateSectionKey(update.section, allowDynamic);
      const existing = prd.sections[update.section];
      const previousVersion = existing ? existing.version : 0;
      const newVersion = previousVersion + 1;
      const diff = this.computeDiff(existing?.content ?? "", update.content);

      prd.sections[update.section] = {
        content: update.content,
        version: newVersion,
        updatedAt: now,
      };

      prd.changeLog.push({
        section: update.section,
        version: newVersion,
        source,
        timestamp: now,
        diff,
      });

      changes.push({ section: update.section, previousVersion, newVersion });
    }

    if (changes.length > 0) {
      prd.version += 1;
      await this.savePrd(projectId, prd, { source });
    }

    return changes;
  }

  /** Get PRD change history */
  async getHistory(projectId: string): Promise<PrdChangeLogEntry[]> {
    const prd = await this.loadPrd(projectId);
    return prd.changeLog;
  }
}
