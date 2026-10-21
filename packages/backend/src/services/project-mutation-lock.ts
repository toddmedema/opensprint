/** One local mutation owner across service instances; never hold a SQL transaction here. */
const tails = new Map<string, Promise<void>>();

export async function withProjectMutation<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(projectId, next);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(projectId) === next) tails.delete(projectId);
  }
}
