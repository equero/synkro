import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const run = (...args: string[]) =>
  execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" });

test("--version prints the package version", () => {
  assert.equal(run("--version").trim(), version);
});

test("--help lists the commands", () => {
  const out = run("--help");
  for (const cmd of ["init", "sync", "status"]) assert.match(out, new RegExp(`synkro ${cmd}`));
});
