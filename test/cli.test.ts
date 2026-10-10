import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(import.meta.resolve("#cli"));
const { version } = createRequire(import.meta.url)("#package.json");

const run = (...args: string[]) =>
  execFileSync(process.execPath, ["--conditions=development", cli, ...args], { encoding: "utf8" });

test("--version prints the package version", () => {
  assert.equal(run("--version").trim(), version);
});

test("--help lists the commands", () => {
  const out = run("--help");
  for (const cmd of ["init", "sync", "status"]) assert.match(out, new RegExp(`synkro ${cmd}`));
});
