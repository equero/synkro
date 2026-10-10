import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveMainBranch } from "#config";
import { type Context, type Options, openRepo } from "#context";
import { GitError } from "#git";
import { planRelease } from "#release";
import { latestTag, tagExists, tagName } from "#version";

/** Leftovers from the per-project sync-master.mjs + .githooks setup synkro replaces. */
function oldSetup({ git, root }: Context): string[] {
  const found = ["scripts/sync-master.mjs", ".githooks"].filter((path) =>
    existsSync(join(root, path)),
  );
  const hooksDir = git.read("rev-parse", "--git-path", "hooks");
  for (const hook of ["pre-commit", "post-merge"]) {
    const path = join(root, hooksDir, hook);
    if (existsSync(path) && readFileSync(path, "utf8").includes("VERSION_BUMP")) {
      found.push(`.git/hooks/${hook}`);
    }
  }
  if (git.tryRead("config", "core.hooksPath") === ".githooks") found.push("core.hooksPath");
  return found;
}

function lockMismatch({ root }: Context, version: string | null): string | null {
  const lockPath = join(root, "package-lock.json");
  if (!version || !existsSync(lockPath)) return null;
  const lockVersion = JSON.parse(readFileSync(lockPath, "utf8")).version;
  return lockVersion && lockVersion !== version ? lockVersion : null;
}

/** Read-only overview: branches, version, what the next sync would do, and anything blocking it. */
export function status(options: Options): void {
  const ctx = openRepo(options);
  const { git, config, log } = ctx;
  const { develop, remote } = config;
  const problems: string[] = [];
  const notes: string[] = [];

  if (!git.hasCommits()) {
    log("No commits yet. Run `synkro init` to set up main and develop.");
    return;
  }

  const online = git.hasRemote(remote);
  if (online) {
    try {
      git.read("fetch", "--quiet", remote);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      notes.push(`Could not fetch from ${remote}; remote info may be out of date.`);
    }
  }

  const main = resolveMainBranch(git, config);
  // A fresh clone of a repo whose GitHub default is develop has no local main:
  // report from the remote branch instead, and point to init.
  const refOf = (name: string) =>
    git.branchExists(name)
      ? name
      : online && git.remoteBranchExists(remote, name)
        ? `${remote}/${name}`
        : null;
  const mainRef = refOf(main);
  const developRef = refOf(develop);
  if (!mainRef || !developRef) {
    const missing = [main, develop].filter((name) => !refOf(name));
    log(`Missing branch: ${missing.join(", ")}. Run \`synkro init\`.`);
    return;
  }
  const remoteOnly = [main, develop].filter((name) => !git.branchExists(name));
  if (remoteOnly.length) {
    problems.push(
      `${remoteOnly.join(" and ")} only on ${remote}. Run \`synkro init\` once to create it locally.`,
    );
  }

  const branch = git.currentBranch();
  const clean = git.isClean();
  log(
    `Branches   ${main} ← ${develop}   (you're on ${branch ?? "a detached HEAD"}, ${clean ? "clean" : "uncommitted changes"})`,
  );
  if (branch !== develop) problems.push(`Switch to ${develop} before syncing.`);
  if (!clean) problems.push("Commit or stash your changes before syncing.");

  const plan = planRelease(ctx, mainRef, config.bump, developRef);
  const tag = latestTag(git);
  log(
    `Version    ${plan.current ?? "none yet"} from ${plan.kind}` + ` · last tag ${tag ?? "none"}`,
  );
  if (tag && plan.current && !tagExists(git, tagName(plan.current))) {
    notes.push(`No tag ${tagName(plan.current)} for the current version.`);
  }
  const lockVersion = lockMismatch(ctx, plan.current);
  if (lockVersion) {
    notes.push(
      `package-lock.json says ${lockVersion}, package.json says ${plan.current}. The next release fixes it.`,
    );
  }

  if (!git.isAncestor(mainRef, developRef)) {
    problems.push(
      `${main} has commits that ${develop} doesn't. Run \`git merge ${main}\` on ${develop}.`,
    );
  }

  if (plan.pending === 0) {
    log(`Next sync  nothing to release`);
  } else {
    const what = plan.next
      ? `${plan.next} (${config.bump})`
      : `merge only (only ${config.skipIfOnly.join(", ")} changed)`;
    log(`Next sync  ${what} with ${plan.pending} commit(s):`);
    for (const line of plan.commits) log(`             ${line}`);
  }

  if (!online) {
    log(`Remote     no "${remote}" remote`);
  } else {
    const parts = [main, develop].map((name) => {
      const tracking = `${remote}/${name}`;
      if (!git.remoteBranchExists(remote, name)) return `${name} not pushed yet`;
      if (!git.branchExists(name)) return `${name} (only on ${remote})`;
      const ahead = git.countAhead(tracking, name);
      const behind = git.countAhead(name, tracking);
      if (!ahead && !behind) return `${name} ✔`;
      return `${name} ${[ahead && `↑${ahead}`, behind && `↓${behind}`].filter(Boolean).join(" ")}`;
    });
    log(`Remote     ${remote}: ${parts.join(" · ")}`);

    const remoteDevelop = `${remote}/${develop}`;
    if (
      developRef !== remoteDevelop &&
      git.remoteBranchExists(remote, develop) &&
      git.countAhead(develop, remoteDevelop)
    ) {
      problems.push(`${remoteDevelop} has commits you don't have. Run \`git pull\`.`);
    }
    const remoteMain = `${remote}/${main}`;
    if (
      mainRef !== remoteMain &&
      git.remoteBranchExists(remote, main) &&
      git.countAhead(main, remoteMain)
    ) {
      if (git.isAncestor(main, remoteMain)) {
        notes.push(`${remoteMain} is ahead; sync will fast-forward ${main} first.`);
      } else {
        problems.push(`${main} and ${remoteMain} have diverged. Fix ${main} by hand.`);
      }
    }
  }

  const leftovers = oldSetup(ctx);
  if (leftovers.length) {
    notes.push(`Old sync setup still here (synkro replaces it): ${leftovers.join(", ")}`);
  }

  log("");
  for (const note of notes) log(`- ${note}`);
  for (const problem of problems) log(`! ${problem}`);
  if (!problems.length) {
    log(plan.pending ? "✔ Ready to sync." : "✔ All in sync.");
  }
}
