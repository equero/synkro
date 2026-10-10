#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { init } from "./commands/init.ts";
import { sync } from "./commands/sync.ts";
import { BUMPS, type Bump, ConfigError } from "./config.ts";
import { type Options, UsageError } from "./context.ts";
import { GitError } from "./git.ts";
import { VersionError } from "./version.ts";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  version: string;
};

const HELP = `synkro ${version} — keep develop and main in sync and bump the version

Usage:
  synkro init [options]       Set up main/develop in the current repo
  synkro sync [options]       Merge develop into main, bump, tag and push
  synkro status               Show branches, versions and last tag

Options:
  --patch | --minor | --major Bump type for sync (default: minor)
  --no-tag                    Sync without bumping or tagging
  --no-push                   Do everything locally, push nothing
  --dry-run                   Print what would happen, change nothing

  -h, --help                  Show this help
  -v, --version               Show the synkro version
`;

/** Flags each command accepts, so typos like --dryrun fail instead of being ignored. */
const FLAGS: Record<string, string[]> = {
  init: ["--no-push", "--dry-run"],
  sync: ["--patch", "--minor", "--major", "--no-tag", "--no-push", "--dry-run"],
  status: [],
};

function run(command: string, flags: string[]) {
  const allowed = FLAGS[command];
  if (!allowed) throw new UsageError(`Unknown command: ${command}. Run \`synkro --help\`.`);
  const unknown = flags.filter((flag) => !allowed.includes(flag));
  if (unknown.length) {
    throw new UsageError(`Unknown option for ${command}: ${unknown.join(", ")}`);
  }

  const options: Options = {
    cwd: process.cwd(),
    dryRun: flags.includes("--dry-run"),
    push: !flags.includes("--no-push"),
    log: console.log,
  };
  if (options.dryRun) console.log("[dry run] nothing will be changed\n");

  switch (command) {
    case "init":
      return init(options);
    case "sync": {
      const bumps = BUMPS.filter((bump) => flags.includes(`--${bump}`));
      if (bumps.length > 1) throw new UsageError(`Pick only one of --patch, --minor, --major`);
      return sync({
        ...options,
        bump: (bumps[0] as Bump) ?? null,
        tag: !flags.includes("--no-tag"),
      });
    }
    default:
      throw new UsageError(`synkro ${command}: not implemented yet`);
  }
}

const [command, ...flags] = process.argv.slice(2);

if (command === undefined || command === "-h" || command === "--help") {
  process.stdout.write(HELP);
} else if (command === "-v" || command === "--version") {
  console.log(version);
} else {
  try {
    run(command, flags);
  } catch (error) {
    const known = [UsageError, ConfigError, VersionError, GitError];
    if (!known.some((type) => error instanceof type)) throw error;
    console.error(`synkro: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
