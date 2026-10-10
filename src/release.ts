import { basename } from "node:path";
import type { Bump } from "#config";
import type { Context } from "#context";
import { bumpVersion, changelog, readVersion, type VersionSource } from "#version";

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

export interface ReleasePlan extends VersionSource {
  /** Commits on develop that main doesn't have. */
  pending: number;
  /** "- subject (hash)" lines for those commits. */
  commits: string[];
  /** Every changed file matches skipIfOnly, so there's nothing to version. */
  onlySkipped: boolean;
  /** Version the next sync would release; null when it would only merge. */
  next: string | null;
}

/** What the next sync would do, without changing anything. Shared by sync and status. */
export function planRelease(
  ctx: Context,
  main: string,
  bump: Bump,
  develop = ctx.config.develop,
): ReleasePlan {
  const { git, config, root } = ctx;
  const { skipIfOnly } = config;

  const pending = git.countAhead(main, develop);
  const changed = pending
    ? git.read("diff", "--name-only", `${main}...${develop}`).split("\n")
    : [];
  const onlySkipped = pending > 0 && changed.every((file) => matchesAny(file, skipIfOnly));
  const source = readVersion(root, git);

  return {
    ...source,
    pending,
    commits: pending ? changelog(git, main, develop) : [],
    onlySkipped,
    next: pending && !onlySkipped ? bumpVersion(source.current ?? "0.0.0", bump) : null,
  };
}
