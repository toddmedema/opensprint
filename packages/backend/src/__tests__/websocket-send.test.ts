import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  sendSocketData,
  MAX_SOCKET_BUFFER_BYTES,
  MAX_SOCKET_EVENT_BYTES,
} from "../websocket/send.js";
describe("bounded websocket delivery", () => {
  it("closes a slow client before adding another event to the queue", () => {
    const ws = {
      readyState: 1,
      bufferedAmount: MAX_SOCKET_BUFFER_BYTES - 2,
      close: vi.fn(),
      send: vi.fn(),
    };
    expect(sendSocketData(ws as unknown as WebSocket, "€")).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(1013, expect.any(String));
  });
  it("rejects oversized frames and leaves healthy clients working", () => {
    const ws = { readyState: 1, bufferedAmount: 0, close: vi.fn(), send: vi.fn() };
    expect(sendSocketData(ws as unknown as WebSocket, "a".repeat(MAX_SOCKET_EVENT_BYTES + 1))).toBe(
      false
    );
    expect(ws.close).toHaveBeenCalledWith(1009, expect.any(String));
    expect(sendSocketData(ws as unknown as WebSocket, "small event")).toBe(true);
  });
});
