import type { Response } from "express";

export const NOTIFY_TYPES = [
  "run.updated",
  "work_item.updated",
  "thread.appended",
  "runbook.updated",
  "membership.updated",
] as const;

export type NotifyType = (typeof NOTIFY_TYPES)[number];

export class NotifyHub {
  private readonly listeners = new Map<string, Set<Response>>();

  publish(projectId: string, type: NotifyType): void {
    const listeners = this.listeners.get(projectId);
    if (!listeners) return;
    const payload = `event: ${type}\ndata: {}\n\n`;
    for (const response of listeners) response.write(payload);
  }

  subscribe(projectId: string, response: Response): void {
    const set = this.listeners.get(projectId) ?? new Set<Response>();
    set.add(response);
    this.listeners.set(projectId, set);
    response.write(": connected\n\n");
  }

  unsubscribe(projectId: string, response: Response): void {
    this.listeners.get(projectId)?.delete(response);
  }
}
