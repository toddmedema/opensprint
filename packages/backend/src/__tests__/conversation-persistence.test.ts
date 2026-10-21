import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { initAppDb, type AppDb } from "../db/app-db.js";
import { ChatService } from "../services/chat.service.js";
const refs = vi.hoisted(() => ({ appDb: null as AppDb | null }));
vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    getDb: () => refs.appDb!.getClient(),
    runWrite: (fn: Parameters<AppDb["runWrite"]>[0]) => refs.appDb!.runWrite(fn),
  },
  TaskStoreService: class {},
}));
vi.mock("../services/agent.service.js", () => ({ agentService: {} }));
vi.mock("../websocket/index.js", () => ({ broadcastToProject: vi.fn() }));

describe("conversation append persistence (SQLite)", () => {
  let service: ChatService;
  beforeEach(async () => {
    refs.appDb = await initAppDb("sqlite://:memory:");
    const db = await refs.appDb.getClient();
    await db.execute(
      `INSERT INTO project_conversations (project_id, context, conversation_id, messages, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      ["project", "sketch", "conversation", "[]", "now", "now"]
    );
    service = new ChatService();
  });
  afterEach(async () => {
    await refs.appDb?.close();
  });
  it("preserves concurrent appends which read the same initial snapshot", async () => {
    await Promise.all([
      service.addSketchAssistantMessage("project", "first"),
      service.addSketchAssistantMessage("project", "second"),
      service.addDirectEditMessage("project", "feature_list", "updated"),
    ]);
    const history = await service.getHistory("project", "sketch");
    expect(history.id).toBe("conversation");
    expect(history.messages).toHaveLength(3);
    expect(history.messages.map((message) => message.content)).toEqual(
      expect.arrayContaining([
        "first",
        "second",
        expect.stringContaining("I edited the Feature List"),
      ])
    );
  });
});
