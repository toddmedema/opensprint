export class ForgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ForgeError";
  }
}

export function isForgeError(error: unknown): error is ForgeError {
  return error instanceof ForgeError;
}
