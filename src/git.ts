import { execFileSync } from "node:child_process";

export class GitError extends Error {
  readonly args: string[];
  readonly stderr: string;

  constructor(args: string[], stderr: string) {
    super(`git ${formatArgs(args)} failed${stderr ? `:\n${stderr}` : ""}`);
    this.args = args;
    this.stderr = stderr;
  }
}

export interface GitOptions {
  cwd: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}

const formatArgs = (args: string[]) =>
  args.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");

/**
 * Single entry point for every git call. Reads always run; writes are only
 * printed when dryRun is on, so commands never need their own dry-run checks.
 */
export function createGit({ cwd, dryRun = false, log = console.log }: GitOptions) {
  const exec = (args: string[]) => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim() ?? "";
      throw new GitError(args, stderr);
    }
  };

  /** Runs a command that only reads repo state. */
  const read = (...args: string[]) => exec(args);

  /** Like read, but returns null when git fails (for "does X exist?" checks). */
  const tryRead = (...args: string[]) => {
    try {
      return exec(args);
    } catch (error) {
      if (error instanceof GitError) return null;
      throw error;
    }
  };

  /** Runs a command that changes the repo or the remote. Only printed in dry-run. */
  const write = (...args: string[]) => {
    if (dryRun) {
      log(`  git ${formatArgs(args)}`);
      return "";
    }
    return exec(args);
  };

  return {
    cwd,
    dryRun,
    read,
    tryRead,
    write,

    /** Top-level folder of the repo, or null when cwd is not inside one. */
    root: () => tryRead("rev-parse", "--show-toplevel"),

    hasCommits: () => tryRead("rev-parse", "--verify", "--quiet", "HEAD") !== null,

    /** Current branch name, or null on a detached HEAD. */
    currentBranch: () => tryRead("symbolic-ref", "--short", "--quiet", "HEAD"),

    /** No uncommitted changes to tracked files (untracked files don't block a merge). */
    isClean: () => read("status", "--porcelain", "--untracked-files=no") === "",

    /** Commits in `ref` that `base` doesn't have. */
    countAhead: (base: string, ref: string) =>
      Number(read("rev-list", "--count", `${base}..${ref}`)),

    isAncestor: (ancestor: string, ref: string) =>
      tryRead("merge-base", "--is-ancestor", ancestor, ref) !== null,

    hasRemote: (remote: string) => tryRead("remote", "get-url", remote) !== null,

    branchExists: (name: string) =>
      tryRead("rev-parse", "--verify", "--quiet", `refs/heads/${name}`) !== null,

    remoteBranchExists: (remote: string, name: string) =>
      tryRead("rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${name}`) !== null,
  };
}

export type Git = ReturnType<typeof createGit>;
