import { basename } from "node:path";
import { type Bump, resolveMainBranch } from "../config.ts";
import { type Context, type Options, openRepo, UsageError } from "../context.ts";
import { GitError } from "../git.ts";
import {
  bumpVersion,
  changelog,
  readVersion,
  tagExists,
  tagName,
  writeVersion,
} from "../version.ts";

export interface SyncOptions extends Options {
  /** null = use the configured default. */
  bump: Bump | null;
  tag: boolean;
}

/** Converts a simple glob (*, **, ?) to a RegExp. Patterns without "/" match the file name. */
function globToRegExp(glob: string): RegExp {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0001")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replaceAll("\u0001", "(?:.*/)?")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${source}$`);
}

const matchesAny = (file: string, globs: string[]) =>
  globs.some((glob) => globToRegExp(glob).test(glob.includes("/") ? file : basename(file)));

/** Fails unless the repo is in a state where a release can't go wrong halfway. */
function checkState(ctx: Context, main: string, online: boolean) {
  const { git, config } = ctx;
  const { develop, remote } = config;

  const branch = git.currentBranch();
  if (branch !== develop) {
    throw new UsageError(`Switch to ${develop} first (you're on ${branch ?? "a detached HEAD"}).`);
  }
  if (!git.isClean()) {
    throw new UsageError("You have uncommitted changes. Commit or stash them first.");
  }
  if (!git.branchExists(main)) {
    throw new UsageError(`Branch ${main} doesn't exist. Run \`synkro init\` first.`);
  }

  if (online) {
    try {
      git.read("fetch", "--quiet", remote);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      throw new UsageError(
        `Could not fetch from ${remote}:\n${error.stderr}\nUse --no-push to release locally.`,
      );
    }

    if (
      git.remoteBranchExists(remote, develop) &&
      git.countAhead(develop, `${remote}/${develop}`)
    ) {
      throw new UsageError(
        `${remote}/${develop} has commits you don't have. Run \`git pull\` first.`,
      );
    }
    // Someone else's release or a hotfix may have moved main on the remote.
    const remoteMain = `${remote}/${main}`;
    if (git.remoteBranchExists(remote, main) && git.countAhead(main, remoteMain)) {
      if (!git.isAncestor(main, remoteMain)) {
        throw new UsageError(`${main} and ${remoteMain} have diverged. Fix ${main} by hand first.`);
      }
      git.write("branch", "--force", main, remoteMain);
      ctx.log(`✔ ${main} fast-forwarded to ${remoteMain}`);
    }
  }

  if (!git.isAncestor(main, develop)) {
    throw new UsageError(
      `${main} has commits that ${develop} doesn't (a hotfix?). Bring them in first:\n` +
        `  git merge ${main}`,
    );
  }
}

/**
 * Releases develop into main. The version bump goes inside the merge commit,
 * so a release is one commit; develop is then fast-forwarded to it.
 */
export function sync(options: SyncOptions): void {
  const ctx = openRepo(options);
  const { git, config, log, root } = ctx;
  const { develop, remote } = config;

  if (!git.hasCommits()) throw new UsageError("This repo has no commits. Run `synkro init` first.");
  const main = resolveMainBranch(git, config);
  const online = ctx.push && git.hasRemote(remote);
  checkState(ctx, main, online);

  const pending = git.countAhead(main, develop);
  if (pending === 0) {
    log(`Nothing to release: ${develop} has no commits that ${main} doesn't have.`);
    return;
  }

  const changed = git.read("diff", "--name-only", `${main}...${develop}`).split("\n");
  const onlySkipped = changed.every((file) => matchesAny(file, config.skipIfOnly));
  const bump = options.bump ?? config.bump;
  const { kind, current } = readVersion(root, git);

  let next: string | null = null;
  if (!options.tag) {
    log(`Merging ${pending} commit(s) without a new version (--no-tag).`);
  } else if (onlySkipped) {
    log(
      `Merging ${pending} commit(s) without a new version (only ${config.skipIfOnly.join(", ")} changed).`,
    );
  } else {
    next = bumpVersion(current ?? "0.0.0", bump);
    if (tagExists(git, tagName(next))) {
      throw new UsageError(
        `Tag ${tagName(next)} already exists. Is the version in ${kind} behind?`,
      );
    }
    log(`Releasing ${current ?? "(none)"} → ${next} (${bump}, from ${kind})`);
  }

  const commits = changelog(git, main, develop);
  log(commits.map((line) => `  ${line}`).join("\n"));
  log("");

  const tag = next ? tagName(next) : null;
  const message = next ? `chore(release): ${tag}` : `Merge branch '${develop}' into ${main}`;
  const mainBefore = git.read("rev-parse", main);
  let committed = false;

  try {
    git.write("switch", "--quiet", main);
    git.write("merge", "--no-ff", "--no-commit", develop);
    // Only package.json releases write files; tag-based ones just get the tag.
    if (next && kind === "package.json") {
      const files = writeVersion(root, next, { dryRun: git.dryRun, log });
      git.write("add", ...files);
    }
    const body = commits.length ? ["-m", commits.join("\n")] : [];
    git.write("commit", "--quiet", "-m", message, ...body);
    committed = true;
    if (tag) git.write("tag", "-a", tag, "-m", `Release ${tag}\n\n${commits.join("\n")}`);
    git.write("switch", "--quiet", develop);
    git.write("merge", "--quiet", "--ff-only", main);
  } catch (error) {
    if (git.dryRun) throw error;
    rollback(ctx, { main, mainBefore, committed, tag });
    throw error;
  }

  const head = git.dryRun ? "" : ` at ${git.read("rev-parse", "--short", main)}`;
  log(`✔ ${tag ? `Released ${tag}` : "Merged"}: ${main} and ${develop}${head}`);

  if (!ctx.push) {
    log("- push skipped (--no-push)");
    return;
  }
  if (!online) {
    log(`- no remote "${remote}": nothing pushed`);
    return;
  }
  const refs = [main, develop, ...(tag ? [tag] : [])];
  try {
    git.write("push", "--quiet", "--atomic", remote, ...refs);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    throw new UsageError(
      `The release is done locally, but the push failed:\n${error.stderr}\n` +
        `Retry with: git push --atomic ${remote} ${refs.join(" ")}`,
    );
  }
  log(`↑ pushed ${refs.join(", ")} to ${remote}`);
}

/** Puts main and develop back where they were before a failed release. */
function rollback(
  ctx: Context,
  state: { main: string; mainBefore: string; committed: boolean; tag: string | null },
) {
  const { git, log, config } = ctx;
  log("✘ Release failed, rolling back...");
  git.tryRead("merge", "--abort");
  if (state.committed) {
    if (state.tag) git.tryRead("tag", "--delete", state.tag);
    if (git.currentBranch() !== state.main) git.tryRead("switch", "--quiet", state.main);
    git.tryRead("reset", "--quiet", "--hard", state.mainBefore);
  }
  git.tryRead("switch", "--quiet", config.develop);
  log(`  ${state.main} is back at ${state.mainBefore.slice(0, 7)}, you're on ${config.develop}.`);
}
