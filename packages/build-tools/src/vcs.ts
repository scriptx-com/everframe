// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import childProcess from 'node:child_process';
import { BuildVcsSchema, type BuildVcs } from '@everframe/protocol';

function commitValue(input: unknown): string | undefined {
  const parsed = BuildVcsSchema.shape.commit.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}
function explicitCommit(input: string): string {
  const commit = commitValue(input);
  if (!commit)
    throw new Error('invalid_commit: expected a full 40- or 64-character hexadecimal commit');
  return commit;
}

/** Override a staged record without consulting the uploader's checkout. */
export function overrideBuildVcs(
  recorded: BuildVcs | undefined,
  commit?: string,
): BuildVcs | undefined {
  if (commit === undefined) return recorded;
  const normalized = explicitCommit(commit);
  return recorded?.commit === normalized ? recorded : { commit: normalized };
}

/** Best-effort build-time detection. Must run before tooling writes generated files. */
export function detectBuildVcs(options: {
  projectRoot: string;
  commit?: string;
  env?: NodeJS.ProcessEnv;
  /** Skip branch and working-tree inspection when only the commit is needed. */
  commitOnly?: boolean;
  /** Optional absolute deadline in milliseconds since the Unix epoch. */
  deadline?: number;
}): BuildVcs | undefined {
  const explicit = options.commit === undefined ? undefined : explicitCommit(options.commit);
  if (options.commitOnly && explicit) return { commit: explicit };
  const env = options.env ?? process.env;
  const git = (args: string[]): string | undefined => {
    const timeout = Math.floor(
      Math.min(1500, options.deadline === undefined ? 1500 : options.deadline - Date.now()),
    );
    if (timeout <= 0) return undefined;
    try {
      return childProcess
        .execFileSync('git', args, {
          cwd: options.projectRoot,
          encoding: 'utf8',
          timeout,
          maxBuffer: 64 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        .trim();
    } catch {
      return undefined;
    }
  };
  const head = commitValue(git(['rev-parse', '--verify', 'HEAD']));
  const commit =
    explicit ??
    head ??
    ['GITHUB_SHA', 'CI_COMMIT_SHA', 'BITBUCKET_COMMIT', 'BUILD_SOURCEVERSION']
      .map((key) => commitValue(env[key]))
      .find((value) => value !== undefined);
  if (!commit) return undefined;
  if (options.commitOnly || commit !== head) return { commit };
  const branch = BuildVcsSchema.shape.branch.safeParse(
    git(['symbolic-ref', '--quiet', '--short', 'HEAD']),
  );
  const status = git(['status', '--porcelain', '--untracked-files=normal']);
  return {
    commit,
    ...(branch.success && branch.data ? { branch: branch.data } : {}),
    ...(status !== undefined ? { dirty: status.length > 0 } : {}),
  };
}
