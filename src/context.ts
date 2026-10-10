import { type Config, loadConfig } from "./config.ts";
import { createGit, type Git } from "./git.ts";

export class UsageError extends Error {}

export interface Options {
  cwd: string;
  dryRun: boolean;
  push: boolean;
  log: (line: string) => void;
}

export interface Context extends Options {
  root: string;
  git: Git;
  config: Config;
}

/** Opens the repo containing cwd and loads its config. */
export function openRepo(options: Options): Context {
  const root = createGit({ cwd: options.cwd }).root();
  if (!root) throw new UsageError("Not inside a git repository. Run `git init` first.");
  const git = createGit({ cwd: root, dryRun: options.dryRun, log: options.log });
  return { ...options, root, git, config: loadConfig(root) };
}
