import { Router, Request } from "express";
import multer from "multer";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateParams, validateBody, validateQuery } from "../middleware/validate.js";
import { projectIdParamSchema } from "../schemas/request-common.js";
import {
  prdDiffQuerySchema,
  prdProposedDiffQuerySchema,
  prdSectionParamsSchema,
  prdSectionPutBodySchema,
} from "../schemas/request-prd.js";
import { prdFromCodebaseService } from "../services/prd-from-codebase.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { notificationService } from "../services/notification.service.js";
import { prdProposalStore, hashSpecContent } from "../services/prd-proposal-store.js";
import { specPublicationService } from "../services/spec-publication.service.js";
import {
  applyDiffPagination,
  computeLineDiff,
  isDiffContentPayloadTooLarge,
} from "../utils/diff.js";
import { prdToSpecMarkdown } from "@opensprint/shared";
import type { PrdService } from "../services/prd.service.js";
import type { ChatService } from "../services/chat.service.js";
import type {
  ApiResponse,
  Prd,
  PrdSection,
  PrdChangeLogEntry,
  ScopeChangeProposedUpdate,
} from "@opensprint/shared";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

type ProjectParams = { projectId: string };
type SectionParams = { projectId: string; section: string };
interface PrdRouterDeps {
  prdService: Pick<
    PrdService,
    | "getPrd"
    | "getHistory"
    | "getSnapshot"
    | "listSnapshotVersions"
    | "getSection"
    | "updateSection"
  >;
  chatService: Pick<ChatService, "addDirectEditMessage">;
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const mammothModule = await import("mammoth");
  const mammoth = "default" in mammothModule ? mammothModule.default : mammothModule;
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return result.text;
}

export function createPrdRouter({ prdService, chatService }: PrdRouterDeps): Router {
  const prdRouter = Router({ mergeParams: true });

  // GET /projects/:projectId/prd — Get full PRD
  prdRouter.get(
    "/",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const prd = await prdService.getPrd(req.params.projectId);
      const body: ApiResponse<Prd> = { data: prd };
      res.json(body);
    })
  );

  // GET /projects/:projectId/prd/history — Get PRD change log
  prdRouter.get(
    "/history",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const changeLog = await prdService.getHistory(req.params.projectId);
      const body: ApiResponse<PrdChangeLogEntry[]> = { data: changeLog };
      res.json(body);
    })
  );

  // POST /projects/:projectId/prd/generate-from-codebase — Generate PRD from existing codebase (before /:section).
  // projectId from params ensures PRD is written to the project's repo, not the Open Sprint server repo.
  prdRouter.post(
    "/generate-from-codebase",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      await prdFromCodebaseService.generatePrdFromCodebase(req.params.projectId);
      res.status(204).send();
    })
  );

  // GET /projects/:projectId/prd/diff?fromVersion=<versionId>&toVersion=<versionId|'current'>
  // Returns diff between two SPEC.md versions. toVersion defaults to 'current' (current SPEC.md from disk).
  prdRouter.get(
    "/diff",
    validateParams(projectIdParamSchema),
    validateQuery(prdDiffQuerySchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const { projectId } = req.params;
      const query = req.query as unknown as {
        fromVersion: number;
        toVersion?: string;
        includeContent: boolean;
        lineOffset: number;
        lineLimit: number;
      };
      const fromVersion = query.fromVersion;
      const toVersionParam = query.toVersion;
      const includeContent = query.includeContent;
      const lineOffset = query.lineOffset;
      const lineLimit = query.lineLimit;

      const fromContent = await prdService.getSnapshot(projectId, fromVersion);
      if (fromContent === null) {
        res.status(404).json({
          error: { code: "NOT_FOUND", message: `No snapshot found for version ${fromVersion}` },
        });
        return;
      }

      const useCurrent =
        toVersionParam === undefined || toVersionParam === "" || toVersionParam === "current";
      let toContent: string;
      let resolvedToVersion: string;

      if (useCurrent) {
        const prd = await prdService.getPrd(projectId);
        toContent = prdToSpecMarkdown(prd);
        resolvedToVersion = "current";
      } else {
        const toVersion = Number(toVersionParam);
        if (!Number.isInteger(toVersion) || toVersion < 0) {
          res.status(400).json({
            error: {
              code: "INVALID_INPUT",
              message: "Query parameter 'toVersion' must be 'current' or a non-negative integer",
            },
          });
          return;
        }
        const snapshot = await prdService.getSnapshot(projectId, toVersion);
        if (snapshot === null) {
          res.status(404).json({
            error: { code: "NOT_FOUND", message: `No snapshot found for version ${toVersion}` },
          });
          return;
        }
        toContent = snapshot;
        resolvedToVersion = String(toVersion);
      }

      const fullDiff = computeLineDiff(fromContent, toContent);
      const diff = applyDiffPagination(fullDiff, lineOffset, lineLimit);
      const data: Record<string, unknown> = {
        fromVersion: String(fromVersion),
        toVersion: resolvedToVersion,
        diff,
      };
      if (includeContent) {
        if (isDiffContentPayloadTooLarge(fromContent, toContent)) {
          data.contentOmittedDueToSize = true;
        } else {
          data.fromContent = fromContent;
          data.toContent = toContent;
        }
      }
      res.json({ data });
    })
  );

  // GET /projects/:projectId/prd/proposed-diff?requestId=<id>
  // Returns diff between current SPEC and proposed SPEC for a hil_approval request. Register before /:section.
  prdRouter.get(
    "/proposed-diff",
    validateParams(projectIdParamSchema),
    validateQuery(prdProposedDiffQuerySchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const { projectId } = req.params;
      const query = req.query as unknown as {
        requestId: string;
        includeContent: boolean;
        lineOffset: number;
        lineLimit: number;
      };
      const requestId = query.requestId;
      const includeContent = query.includeContent;
      const lineOffset = query.lineOffset;
      const lineLimit = query.lineLimit;

      const notification = await notificationService.getById(projectId, requestId);
      if (!notification || notification.kind !== "hil_approval") {
        res.status(404).json({
          error: {
            code: "NOT_FOUND",
            message: "HIL approval request not found or is not a PRD approval request",
          },
        });
        return;
      }

      const pendingProposal = await prdProposalStore.getDurable(requestId);
      const scopeMeta = notification.scopeChangeMetadata as
        | import("@opensprint/shared").ScopeChangeMetadata
        | undefined;
      const proposedUpdates = scopeMeta?.scopeChangeProposedUpdates as
        | ScopeChangeProposedUpdate[]
        | undefined;
      const hasLegacyProposed = Array.isArray(proposedUpdates) && proposedUpdates.length > 0;

      if (!pendingProposal && !hasLegacyProposed) {
        res.status(404).json({
          error: {
            code: "NOT_FOUND",
            message: "HIL approval request not found or is not a PRD approval request",
          },
        });
        return;
      }

      const currentPrd = await prdService.getPrd(projectId);
      const currentDraft = await specPublicationService.getDraft(projectId);
      const currentSpec = currentDraft
        ? String(currentDraft.content)
        : await specPublicationService.getPublishedContent(projectId);

      let proposedSpec: string;
      let staleBase: boolean | undefined;
      if (pendingProposal) {
        proposedSpec = pendingProposal.proposedContent;
        if (pendingProposal.baseContentHash) {
          const currentHash = hashSpecContent(currentSpec);
          if (currentHash !== pendingProposal.baseContentHash) {
            staleBase = true;
          }
        }
      } else {
        const proposedPrd = JSON.parse(JSON.stringify(currentPrd)) as Prd;
        const now = new Date().toISOString();
        for (const u of proposedUpdates!) {
          const existing = proposedPrd.sections[u.section];
          proposedPrd.sections[u.section] = {
            content: u.content,
            version: existing ? existing.version + 1 : 1,
            updatedAt: now,
          };
        }
        proposedSpec = prdToSpecMarkdown(proposedPrd);
      }

      const fullDiff = computeLineDiff(currentSpec, proposedSpec);
      const diff = applyDiffPagination(fullDiff, lineOffset, lineLimit);

      const data: Record<string, unknown> = {
        requestId,
        diff,
      };
      if (staleBase) {
        data.staleBase = true;
      }
      if (includeContent) {
        if (isDiffContentPayloadTooLarge(currentSpec, proposedSpec)) {
          data.contentOmittedDueToSize = true;
        } else {
          data.fromContent = currentSpec;
          data.toContent = proposedSpec;
        }
      }
      res.json({ data });
    })
  );

  // GET /projects/:projectId/prd/:section — Get a specific PRD section
  prdRouter.get(
    "/:section",
    validateParams(prdSectionParamsSchema),
    wrapAsync(async (req: Request<SectionParams>, res) => {
      const section = await prdService.getSection(req.params.projectId, req.params.section);
      const body: ApiResponse<PrdSection> = { data: section };
      res.json(body);
    })
  );

  // PUT /projects/:projectId/prd/:section — Update a specific PRD section (direct edit)
  prdRouter.put(
    "/:section",
    validateParams(prdSectionParamsSchema),
    validateBody(prdSectionPutBodySchema),
    wrapAsync(async (req: Request<SectionParams>, res) => {
      const { content, source, expectedVersion } = req.body as {
        content: string;
        source?: string;
        expectedVersion?: number;
      };
      const result = await prdService.updateSection(
        req.params.projectId,
        req.params.section,
        content,
        (source ?? "sketch") as PrdChangeLogEntry["source"],
        ...(expectedVersion === undefined ? [] : [expectedVersion])
      );

      // Sync direct edit to conversation context (PRD §7.1.5)
      await chatService.addDirectEditMessage(req.params.projectId, req.params.section, content);

      // Broadcast PRD update via WebSocket
      broadcastToProject(req.params.projectId, {
        type: "prd.updated",
        section: req.params.section,
        version: result.newVersion,
      });

      res.json({
        data: {
          section: result.section,
          previousVersion: result.previousVersion,
          newVersion: result.newVersion,
        },
      });
    })
  );

  // POST /projects/:projectId/prd/upload — Upload a PRD document (.md, .docx, .pdf)
  prdRouter.post(
    "/upload",
    validateParams(projectIdParamSchema),
    upload.single("file"),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const file = (req as unknown as { file?: Express.Multer.File }).file;
      if (!file) {
        res.status(400).json({ error: { code: "BAD_REQUEST", message: "No file provided" } });
        return;
      }

      const ext = file.originalname.split(".").pop()?.toLowerCase();
      let extractedText: string;

      switch (ext) {
        case "md": {
          extractedText = file.buffer.toString("utf-8");
          break;
        }
        case "docx": {
          extractedText = await extractDocxText(file.buffer);
          break;
        }
        case "pdf": {
          extractedText = await extractPdfText(file.buffer);
          break;
        }
        default:
          res.status(400).json({
            error: {
              code: "BAD_REQUEST",
              message: "Unsupported file type. Use .md, .docx, or .pdf",
            },
          });
          return;
      }

      const body: ApiResponse<{ text: string; filename: string }> = {
        data: { text: extractedText, filename: file.originalname },
      };
      res.json(body);
    })
  );

  return prdRouter;
}
