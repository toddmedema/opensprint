import type { WebSocket } from "ws";

/** Slow clients reconnect and refetch/replay; never keep an unbounded socket queue. */
export const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
export const MAX_SOCKET_EVENT_BYTES = 8 * 1024 * 1024;

export function sendSocketData(client: WebSocket, data: string): boolean {
  if (client.readyState !== 1) return false;
  try {
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > MAX_SOCKET_EVENT_BYTES) {
      client.close(1009, "Event exceeds stream limit; refresh authoritative state");
      return false;
    }
    if ((client.bufferedAmount ?? 0) + bytes > MAX_SOCKET_BUFFER_BYTES) {
      client.close(1013, "Client is behind; reconnect and refresh authoritative state");
      return false;
    }
    client.send(data);
    return true;
  } catch {
    return false;
  }
}
