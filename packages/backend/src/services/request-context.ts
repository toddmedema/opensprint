import { AsyncLocalStorage } from "node:async_hooks";
import type { ProjectIdentity } from "@opensprint/shared";
export interface ApplicationRequestContext {
  principal: ProjectIdentity;
  projectId?: string;
  requestId?: string;
  expectedRevision?: number;
}
const context = new AsyncLocalStorage<ApplicationRequestContext>();
export const runWithRequestContext = <T>(value: ApplicationRequestContext, action: () => T): T =>
  context.run(value, action);
export const getRequestContext = (): ApplicationRequestContext | undefined => context.getStore();
