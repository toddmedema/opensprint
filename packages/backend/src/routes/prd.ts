import { Router, Request } from 'express';
import multer from 'multer';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { PrdService } from '../services/prd.service.js';
import { ChatService } from '../services/chat.service.js';
import { broadcastToProject } from '../websocket/index.js';
import type { ApiResponse, Prd, PrdSection, PrdChangeLogEntry } from '@opensprint/shared';

const prdService = new PrdService();

/** Normalize source: "spec" is legacy alias for "sketch". */
function normalizePrdSource(source: string | undefined): PrdChangeLogEntry['source'] {
  const raw = source ?? 'sketch';
  return (raw === 'spec' ? 'sketch' : raw) as PrdChangeLogEntry['source'];
}
const chatService = new ChatService();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export const prdRouter = Router({ mergeParams: true });

type ProjectParams = { projectId: string };
type SectionParams = { projectId: string; section: string };

// GET /projects/:projectId/prd — Get full PRD
prdRouter.get('/', async (req: Request<ProjectParams>, res, next) => {
  try {
    const prd = await prdService.getPrd(req.params.projectId);
    const body: ApiResponse<Prd> = { data: prd };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/prd/history — Get PRD change log
prdRouter.get('/history', async (req: Request<ProjectParams>, res, next) => {
  try {
    const changeLog = await prdService.getHistory(req.params.projectId);
    const body: ApiResponse<PrdChangeLogEntry[]> = { data: changeLog };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/prd/:section — Get a specific PRD section
prdRouter.get('/:section', async (req: Request<SectionParams>, res, next) => {
  try {
    const section = await prdService.getSection(
      req.params.projectId,
      req.params.section,
    );
    const body: ApiResponse<PrdSection> = { data: section };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// PUT /projects/:projectId/prd/:section — Update a specific PRD section (direct edit)
prdRouter.put('/:section', async (req: Request<SectionParams>, res, next) => {
  try {
    const { content, source } = req.body as { content?: string; source?: string };
    if (content === undefined || content === null) {
      res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'Request body must include "content" field' },
      });
      return;
    }
    const result = await prdService.updateSection(
      req.params.projectId,
      req.params.section,
      content,
      normalizePrdSource(source),
    );

    // Sync direct edit to conversation context (PRD §7.1.5)
    await chatService.addDirectEditMessage(
      req.params.projectId,
      req.params.section,
      content,
    );

    // Broadcast PRD update via WebSocket
    broadcastToProject(req.params.projectId, {
      type: 'prd.updated',
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
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/prd/upload — Upload a PRD document (.md, .docx, .pdf)
prdRouter.post('/upload', upload.single('file'), async (req: Request<ProjectParams>, res, next) => {
  try {
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'No file provided' } });
      return;
    }

    const ext = file.originalname.split('.').pop()?.toLowerCase();
    let extractedText: string;

    switch (ext) {
      case 'md': {
        extractedText = file.buffer.toString('utf-8');
        break;
      }
      case 'docx': {
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        extractedText = result.value;
        break;
      }
      case 'pdf': {
        const parser = new PDFParse({ data: file.buffer });
        const result = await parser.getText();
        extractedText = result.text;
        break;
      }
      default:
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'Unsupported file type. Use .md, .docx, or .pdf' },
        });
        return;
    }

    const body: ApiResponse<{ text: string; filename: string }> = {
      data: { text: extractedText, filename: file.originalname },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
