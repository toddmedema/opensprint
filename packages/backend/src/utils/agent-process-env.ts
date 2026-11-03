/**
 * Human governance capabilities belong to the server/UI approval channel. They are never
 * inherited by task, reviewer, merger, planning CLI, or tool-command subprocesses.
 * This is a cooperative local boundary; the same OS user can still inspect server files.
 * O(e) time and auxiliary space for e environment entries.
 */
export function agentProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => !/^OPENSPRINT_GOVERNANCE_(APPROVAL|OWNER|REVIEWERS|CAPABILITY)/i.test(key)
    )
  );
}
