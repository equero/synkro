#!/usr/bin/env node

import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  version: string;
};

const HELP = `synkro ${version} — keep develop and main in sync and bump the version

Usage:
  synkro init                 Set up main/develop in the current repo
  synkro sync [options]       Merge develop into main, bump, tag and push
  synkro status               Show branches, versions and last tag

Sync options:
  --patch | --minor | --major Bump type (default: minor)
  --no-tag                    Merge without bumping or tagging
  --no-push                   Do everything locally, push nothing
  --dry-run                   Print what would happen, change nothing

  -h, --help                  Show this help
  -v, --version               Show the synkro version
`;

const [command] = process.argv.slice(2);

switch (command) {
  case undefined:
  case "-h":
  case "--help":
    process.stdout.write(HELP);
    break;
  case "-v":
  case "--version":
    console.log(version);
    break;
  case "init":
  case "sync":
  case "status":
    console.error(`synkro ${command}: not implemented yet`);
    process.exitCode = 1;
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    process.stderr.write(HELP);
    process.exitCode = 1;
}
