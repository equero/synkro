import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Git } from "#git";

export const BUMPS = ["major", "minor", "patch"] as const;
export type Bump = (typeof BUMPS)[number];

export interface Config {
  /** Main branch name; null means "detect main or master". */
  main: string | null;
  develop: string;
  remote: string;
  bump: Bump;
  /** Glob patterns: if every changed file matches one, sync merges without bumping. */
  skipIfOnly: string[];
}

export const DEFAULTS: Config = {
  main: null,
  develop: "develop",
  remote: "origin",
  bump: "minor",
  skipIfOnly: ["*.md"],
};

export const RC_FILE = ".synkrorc.json";

export class ConfigError extends Error {}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`Could not parse ${path}: ${(error as Error).message}`);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown) => typeof value === "string" && value.trim() !== "";

function validate(raw: unknown, source: string): Partial<Config> {
  if (!isRecord(raw)) throw new ConfigError(`${source} must be a JSON object`);

  const fail = (message: string): never => {
    throw new ConfigError(`${source}: ${message}`);
  };
  const config: Partial<Config> = {};

  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "main":
      case "develop":
      case "remote":
        if (!nonEmptyString(value)) fail(`"${key}" must be a non-empty string`);
        config[key] = (value as string).trim();
        break;
      case "bump":
        if (!BUMPS.includes(value as Bump)) {
          fail(`"bump" must be one of ${BUMPS.join(", ")} (got ${JSON.stringify(value)})`);
        }
        config.bump = value as Bump;
        break;
      case "skipIfOnly":
        if (!Array.isArray(value) || !value.every(nonEmptyString)) {
          fail(`"skipIfOnly" must be an array of glob strings`);
        }
        config.skipIfOnly = value as string[];
        break;
      default:
        fail(`unknown option "${key}" (valid: ${Object.keys(DEFAULTS).join(", ")})`);
    }
  }
  return config;
}

/**
 * Loads config from the "synkro" key in package.json or from .synkrorc.json
 * (not both, to avoid guessing which one wins) and fills in the defaults.
 */
export function loadConfig(root: string): Config {
  const rcPath = join(root, RC_FILE);
  const pkgPath = join(root, "package.json");

  const fromRc = existsSync(rcPath) ? validate(readJson(rcPath), RC_FILE) : null;

  const pkg = existsSync(pkgPath) ? readJson(pkgPath) : null;
  const pkgSection = isRecord(pkg) ? pkg.synkro : undefined;
  const fromPkg =
    pkgSection === undefined ? null : validate(pkgSection, `"synkro" in package.json`);

  if (fromRc && fromPkg) {
    throw new ConfigError(
      `Config found in both ${RC_FILE} and package.json ("synkro" key). Keep only one.`,
    );
  }

  const config = { ...DEFAULTS, ...(fromRc ?? fromPkg) };
  if (config.main === config.develop) {
    throw new ConfigError(`"main" and "develop" can't be the same branch (${config.main})`);
  }
  return config;
}

/**
 * Picks the main branch: the configured one, otherwise whichever of main/master
 * exists locally or on the remote. Repos that default to develop on GitHub only
 * have origin/main after a clone, so remote branches count too.
 */
export function resolveMainBranch(git: Git, config: Config): string {
  if (config.main) return config.main;

  const exists = (name: string) =>
    git.branchExists(name) || git.remoteBranchExists(config.remote, name);
  const hasMain = exists("main");
  const hasMaster = exists("master");

  if (hasMain && hasMaster) {
    throw new ConfigError(
      `Both "main" and "master" exist. Set which one to use, e.g. in ${RC_FILE}:\n` +
        `  { "main": "main" }`,
    );
  }
  return hasMaster ? "master" : "main";
}
