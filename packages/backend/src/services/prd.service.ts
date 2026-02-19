import fs from "fs/promises";
import path from "path";
import type { Prd, PrdSection, PrdChangeLogEntry, PrdSectionKey } from "@opensprint/shared";

/** PRD as loaded from disk; changeLog may contain legacy "spec" source (normalized to "sketch" when loading) */
interface PrdFromDisk extends Omit<Prd, "changeLog"> {
  changeLog: Array<Omit<PrdChangeLogEntry, "source"> & { source: PrdChangeLogEntry["source"] | "spec" }>;
}
import { OPENSPRINT_PATHS } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { gitCommitQueue } from "./git-commit-queue.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { writeJsonAtomic } from "../utils/file-utils.js";

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

export class PrdService {
  private projectService = new ProjectService();

  /** Get the file path for a project's PRD */
  private async getPrdPath(projectId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    return path.join(project.repoPath, OPENSPRINT_PATHS.prd);
  }

  /** Normalize legacy "spec" source to "sketch" in changeLog entries. */
  private normalizePrdSources(prd: PrdFromDisk): Prd {
    if (!Array.isArray(prd.changeLog)) return prd as Prd;
    const normalized: PrdChangeLogEntry[] = prd.changeLog.map((e) => {
      if (e.source === "spec") {
        return { ...e, source: "sketch" as const };
      }
      return e as PrdChangeLogEntry;
    });
    return { ...prd, changeLog: normalized };
  }

  /** Load the PRD from disk */
  private async loadPrd(projectId: string): Promise<Prd> {
    const prdPath = await this.getPrdPath(projectId);
    try {
      const data = await fs.readFile(prdPath, "utf-8");
      const parsed = JSON.parse(data) as PrdFromDisk;
      // Ensure changeLog exists for backward compatibility with older PRD files
      if (!Array.isArray(parsed.changeLog)) {
        parsed.changeLog = [];
      }
      return this.normalizePrdSources(parsed);
    } catch {
      throw new AppError(404, ErrorCodes.PRD_NOT_FOUND, "PRD not found for this project");
    }
  }

  /** Save the PRD to disk (atomic write) and enqueue git commit (PRD §5.9) */
  private async savePrd(
    projectId: string,
    prd: Prd,
    options?: { source?: PrdChangeLogEntry["source"]; planId?: string }
  ): Promise<void> {
    const prdPath = await this.getPrdPath(projectId);
    await writeJsonAtomic(prdPath, prd);
    const project = await this.projectService.getProject(projectId);
    const source = options?.source ?? "sketch";
    gitCommitQueue.enqueue({
      type: "prd_update",
      repoPath: project.repoPath,
      source,
      planId: options?.planId,
    });
  }

  /** Validate a section key */
  private validateSectionKey(key: string): void {
    if (!PRD_SECTION_KEYS.includes(key as PrdSectionKey)) {
      throw new AppError(
        400,
        "INVALID_SECTION",
        `Invalid PRD section key '${key}'. Valid keys: ${PRD_SECTION_KEYS.join(", ")}`,
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

  /** Get a specific PRD section */
  async getSection(projectId: string, sectionKey: string): Promise<PrdSection> {
    this.validateSectionKey(sectionKey);
    const prd = await this.loadPrd(projectId);
    const section = prd.sections[sectionKey as PrdSectionKey];
    if (!section) {
      throw new AppError(404, ErrorCodes.SECTION_NOT_FOUND, `PRD section '${sectionKey}' not found`, { sectionKey });
    }
    return section;
  }

  /** Update a specific PRD section */
  async updateSection(
    projectId: string,
    sectionKey: string,
    content: string,
    source: PrdChangeLogEntry["source"] = "sketch",
  ): Promise<{ section: PrdSection; previousVersion: number; newVersion: number }> {
    this.validateSectionKey(sectionKey);
    const prd = await this.loadPrd(projectId);
    const key = sectionKey as PrdSectionKey;
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
    updates: Array<{ section: PrdSectionKey; content: string }>,
    source: PrdChangeLogEntry["source"] = "sketch",
  ): Promise<Array<{ section: string; previousVersion: number; newVersion: number }>> {
    const prd = await this.loadPrd(projectId);
    const changes: Array<{ section: string; previousVersion: number; newVersion: number }> = [];
    const now = new Date().toISOString();

    for (const update of updates) {
      this.validateSectionKey(update.section);
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
