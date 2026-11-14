import type { Role } from "../domain.js";
import { ForgeError } from "../errors.js";

const RANK: Record<Role, number> = { view: 1, discuss: 2, steer: 3, admin: 4 };

export function isRole(value: string): value is Role {
  return value === "view" || value === "discuss" || value === "steer" || value === "admin";
}

export function hasRole(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

export function assertRole(actual: Role, required: Role): void {
  if (!hasRole(actual, required)) {
    throw new ForgeError(403, "forbidden", `This action requires the ${required} role.`);
  }
}
