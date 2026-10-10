import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bump } from "./config.ts";
import type { Git } from "./git.ts";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export class VersionError extends Error {}

export function parseVersion(text: string): SemVer {
  const match = SEMVER.exec(text.trim().replace(/^v/, ""));
  if (!match) throw new VersionError(`"${text}" is not a valid semver version (x.y.z)`);
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? null,
  };
}

export const formatVersion = ({ major, minor, patch, prerelease }: SemVer) =>
  `${major}.${minor}.${patch}${prerelease ? `-${prerelease}` : ""}`;

/**
 * Semver bump. A prerelease is released as its own version when the bump
 * already covers it: 1.2.0-beta.1 + minor → 1.2.0, 1.2.3-rc.1 + patch → 1.2.3.
 */
export function bumpVersion(text: string, bump: Bump): string {
  const { major, minor, patch, prerelease } = parseVersion(text);
  const pre = prerelease !== null;
  switch (bump) {
    case "major":
      return pre && minor === 0 && patch === 0 ? `${major}.0.0` : `${major + 1}.0.0`;
    case "minor":
      return pre && patch === 0 ? `${major}.${minor}.0` : `${major}.${minor + 1}.0`;
    case "patch":
      return pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
  }
}

export const tagName = (version: string) => `v${version}`;

/** Highest vX.Y.Z tag in the repo (by version, not by date), or null. */
export function latestTag(git: Git): string | null {
  const tags = git.read("tag", "--list", "v[0-9]*", "--sort=-v:refname").split("\n");
  return tags.find((tag) => SEMVER.test(tag.slice(1))) ?? null;
}

export const tagExists = (git: Git, tag: string) =>
  git.tryRead("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`) !== null;

/** "- subject (hash)" lines for the commits in ref that aren't in `since`. */
export function changelog(git: Git, since: string | null, ref: string): string[] {
  const range = since ? `${since}..${ref}` : ref;
  const out = git.read("log", "--no-merges", "--pretty=format:- %s (%h)", range);
  return out ? out.split("\n") : [];
}

export interface VersionSource {
  /** Where the version lives: package.json, or git tags for non-Node projects. */
  kind: "package.json" | "tags";
  /** Current version, or null when there's none yet (no "version" field / no tags). */
  current: string | null;
}

const readJsonFile = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8"));

export function readVersion(root: string, git: Git): VersionSource {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    const tag = latestTag(git);
    return { kind: "tags", current: tag ? tag.slice(1) : null };
  }
  const { version } = readJsonFile(pkgPath);
  if (version === undefined) return { kind: "package.json", current: null };
  if (typeof version !== "string")
    throw new VersionError(`package.json "version" must be a string`);
  parseVersion(version);
  return { kind: "package.json", current: version };
}

/**
 * Finds the top-level "version" value in package.json text and returns its
 * [start, end) offsets, so it can be replaced without touching the formatting.
 */
function findTopLevelVersion(text: string): [number, number] | null {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    else if (char === '"') {
      const end = endOfString(text, i);
      if (depth === 1 && text.slice(i, end) === '"version"') {
        const value = /^\s*:\s*"/.exec(text.slice(end));
        if (value) {
          const start = end + value[0].length - 1;
          return [start, endOfString(text, start)];
        }
      }
      i = end - 1;
    }
  }
  return null;
}

/** Index just after the closing quote of the string starting at `start`. */
function endOfString(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }
  return text.length;
}

const detectIndent = (text: string) => /^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? 2;

/** Adds "version" right after "name" (or first). Only happens once, on init. */
function insertVersion(text: string, version: string): string {
  const pkg = JSON.parse(text) as Record<string, unknown>;
  const entries = Object.entries(pkg);
  const at = entries.findIndex(([key]) => key === "name") + 1;
  entries.splice(at, 0, ["version", version]);
  return `${JSON.stringify(Object.fromEntries(entries), null, detectIndent(text))}\n`;
}

export interface WriteOptions {
  dryRun?: boolean;
  log?: (line: string) => void;
}

/**
 * Writes the version to package.json (keeping its formatting) and to
 * package-lock.json if present. Returns the files changed, for `git add`.
 */
export function writeVersion(
  root: string,
  version: string,
  { dryRun = false, log = console.log }: WriteOptions = {},
): string[] {
  const pkgPath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  const files = ["package.json"];

  const pkgText = readFileSync(pkgPath, "utf8");
  const range = findTopLevelVersion(pkgText);
  const newPkgText = range
    ? `${pkgText.slice(0, range[0])}"${version}"${pkgText.slice(range[1])}`
    : insertVersion(pkgText, version);
  if (JSON.parse(newPkgText).version !== version) {
    throw new VersionError("Could not update the version in package.json");
  }

  let newLockText: string | null = null;
  if (existsSync(lockPath)) {
    const lockText = readFileSync(lockPath, "utf8");
    const lock = JSON.parse(lockText);
    lock.version = version;
    if (lock.packages?.[""]) lock.packages[""].version = version;
    newLockText = `${JSON.stringify(lock, null, detectIndent(lockText))}\n`;
    files.push("package-lock.json");
  }

  if (dryRun) {
    log(`  write version ${version} to ${files.join(" and ")}`);
    return files;
  }
  writeFileSync(pkgPath, newPkgText);
  if (newLockText) writeFileSync(lockPath, newLockText);
  return files;
}
