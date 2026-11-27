#!/usr/bin/env node
// harneto spike S4: admission check for one candidate (D4, benchmark mode).
// With the fix's test files added to the parent commit, at least one must fail;
// on the fix commit they must all pass. Each side is run three times and must
// give the same result each time. Usage: node s4-admit.mjs <pr number>
// Expects the working tree at the candidate's parent commit, dependencies installed.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const c = JSON.parse(readFileSync(join(here, "s4-candidates.json"), "utf8")).find((x) => String(x.pr) === process.argv[2]);
if (!c) throw new Error(`no candidate ${process.argv[2]}`);
const pkgDir = join("packages", c.package);
const tests = c.tests.map((t) => t.slice(pkgDir.length + 1));
const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000);
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: "inherit", ...opts });
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();

function buildDeps() {
  // The test target's dependsOn builds what the package needs; --listTests runs no test.
  const r = sh("npx", ["nx", "run", `${c.package}:test`, "--skip-nx-cache", "--", "--listTests"], { stdio: ["ignore", "ignore", "inherit"] });
  return r.status === 0;
}

function runOnce(label, i) {
  const out = join(process.env.RUNNER_TEMP ?? "/tmp", `jest-${label}-${i}.json`);
  const r = spawnSync("npx", ["jest", "--config", "./jest.config.mjs", "--ci", "--json", `--outputFile=${out}`, ...tests],
    { cwd: pkgDir, stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, CI: "true" }, timeout: 15 * 60_000 });
  if (!existsSync(out)) return { exit: r.status, files: [], note: "no report" };
  const j = JSON.parse(readFileSync(out, "utf8"));
  const files = j.testResults.map((f) => ({
    file: f.name.split(`${pkgDir}/`).pop(),
    status: f.status,
    // A suite that could not run at all (import or syntax error), as against tests that ran and failed.
    could_not_run: f.status === "failed" && f.assertionResults.length === 0,
    failed: f.assertionResults.filter((a) => a.status === "failed").length,
    passed: f.assertionResults.filter((a) => a.status === "passed").length,
  })).sort((a, b) => a.file.localeCompare(b.file));
  return { exit: r.status, files };
}
const same = (runs) => runs.every((r) => JSON.stringify(r) === JSON.stringify(runs[0]));

const result = { pr: c.pr, package: c.package, parent: c.parent, fix: c.sha, tests: c.tests, admitted: false, reasons: [] };
try {
  if (git("rev-parse", "HEAD") !== c.parent) throw new Error("working tree is not at the parent commit");
  if (!buildDeps()) throw new Error("building the package's dependencies failed at the parent");
  result.t_deps_parent = secs();
  git("checkout", c.sha, "--", ...c.tests);
  result.parent_runs = [1, 2, 3].map((i) => runOnce("parent", i));
  result.t_parent_runs = secs();

  git("checkout", "-f", c.sha);
  if (git("diff", "--name-only", c.parent, c.sha).split("\n").some((f) => f === "yarn.lock")) {
    if (sh("yarn", ["--immutable"]).status !== 0) throw new Error("install failed at the fix commit");
  }
  if (!buildDeps()) throw new Error("building the package's dependencies failed at the fix");
  result.fix_runs = [1, 2, 3].map((i) => runOnce("fix", i));
  result.t_total = secs();

  const p = result.parent_runs, f = result.fix_runs;
  if (!same(p)) result.reasons.push("parent runs differ: flaky");
  if (!same(f)) result.reasons.push("fix runs differ: flaky");
  if (p[0].files.length === 0) result.reasons.push("no report at the parent");
  if (!p[0].files.some((x) => x.status === "failed")) result.reasons.push("no test file fails at the parent");
  if (p[0].files.some((x) => x.could_not_run)) result.reasons.push("a test file cannot run at the parent: it may depend on a name the fix introduces (D4 rule 4)");
  if (!(f[0].exit === 0 && f[0].files.length > 0 && f[0].files.every((x) => x.status === "passed"))) result.reasons.push("not all test files pass at the fix");
  result.admitted = result.reasons.length === 0;
} catch (e) {
  result.reasons.push(`error: ${e.message}`);
  result.t_total = secs();
}
writeFileSync("s4-result.json", JSON.stringify(result, null, 2));
const line = `| #${c.pr} | ${c.package} | ${result.admitted ? "admitted" : "not admitted"} | ${result.reasons.join("; ") || "-"} | ${result.t_total}s |`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `| PR | Package | Result | Why not | Check time |\n|---|---|---|---|---|\n${line}\n`);
