import { resolveMainBranch } from "../config.ts";
import { type Options, openRepo, UsageError } from "../context.ts";
import { GitError } from "../git.ts";
import { readVersion } from "../version.ts";

/**
 * Makes sure main and develop exist locally and on the remote. Only creates
 * what's missing; never touches the version (a missing one counts as 0.0.0,
 * so the first sync releases 0.1.0).
 */
export function init(options: Options): void {
  const ctx = openRepo(options);
  const { git, config, log } = ctx;
  const { develop, remote } = config;

  // Branches created in this run (needed in dry-run, where nothing is really created).
  const created = new Set<string>();
  const exists = (branch: string) => created.has(branch) || git.branchExists(branch);

  // A brand-new repo has no commits, so no branch can exist yet. Point the
  // unborn branch at main and give it an empty first commit.
  let newRepoMain: string | null = null;
  if (!git.hasCommits()) {
    if (git.read("ls-files")) {
      throw new UsageError("This repo has no commits but has staged files. Commit them first.");
    }
    newRepoMain = config.main ?? "main";
    git.write("symbolic-ref", "HEAD", `refs/heads/${newRepoMain}`);
    git.write("commit", "--allow-empty", "-m", "chore: initial commit");
    created.add(newRepoMain);
    log(`+ ${newRepoMain}: created with an empty first commit`);
  }

  const online = ctx.push && git.hasRemote(remote);
  if (online) {
    try {
      git.read("fetch", "--quiet", remote);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      throw new UsageError(
        `Could not fetch from ${remote}:\n${error.stderr}\nUse --no-push to set up locally only.`,
      );
    }
  }

  const main = newRepoMain ?? resolveMainBranch(git, config);
  const startedOn = git.currentBranch();

  // main starts from wherever you are; develop starts from main.
  for (const [branch, from] of [
    [main, startedOn ?? "HEAD"],
    [develop, main],
  ] as const) {
    if (exists(branch)) {
      if (!created.has(branch)) log(`✔ ${branch}: exists`);
    } else if (git.remoteBranchExists(remote, branch)) {
      git.write("branch", "--quiet", "--track", branch, `${remote}/${branch}`);
      created.add(branch);
      log(`+ ${branch}: created from ${remote}/${branch}`);
    } else {
      git.write("branch", branch, from);
      created.add(branch);
      log(`+ ${branch}: created from ${from}`);
    }
  }

  if (!git.dryRun && git.tryRead("merge-base", "--is-ancestor", main, develop) === null) {
    log(
      `! ${main} has commits that ${develop} doesn't. Merge ${main} into ${develop} before syncing.`,
    );
  }

  const { kind, current } = readVersion(ctx.root, git);
  log(
    current
      ? `✔ version: ${current} (from ${kind})`
      : `✔ version: none yet (from ${kind}), the first sync releases 0.1.0`,
  );

  if (!ctx.push) {
    log("- push skipped (--no-push)");
  } else if (!online) {
    log(`- no remote "${remote}": set up locally. Later: git push -u ${remote} ${main} ${develop}`);
  } else {
    const missing = [main, develop].filter((b) => !git.remoteBranchExists(remote, b));
    if (missing.length) {
      git.write("push", "--quiet", "-u", remote, ...missing);
      log(`↑ pushed ${missing.join(", ")} to ${remote}`);
    }
    for (const branch of [main, develop].filter((b) => !missing.includes(b))) {
      if (!git.tryRead("rev-parse", "--abbrev-ref", `${branch}@{upstream}`)) {
        git.write("branch", "--quiet", `--set-upstream-to=${remote}/${branch}`, branch);
      }
    }
    if (!missing.length) log(`✔ ${remote}: ${main} and ${develop} already pushed`);
  }

  // Move to develop only from main (or a brand-new repo), never from a feature branch.
  const branchNow = git.currentBranch();
  const onMain = branchNow === main || (created.has(main) && branchNow !== develop);
  if (onMain && (created.has(develop) || git.isClean())) {
    git.write("switch", "--quiet", develop);
    log(`→ switched to ${develop}`);
  }

  log(`\nReady. Work on ${develop} and run \`synkro sync\` to release.`);
}
