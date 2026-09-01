/**
 * Runs the behavioral conformance suite against one SDK runner.
 *
 *   pnpm conformance node          the Node SDK
 *   pnpm conformance python        once runners/python exists
 *
 * A runner is any command that speaks the stdin/stdout contract in run.ts, so
 * adding a language means adding an entry here and a program there, not
 * touching the driver or the scenarios.
 */

import { loadScenarios, nodeRunner, runScenario } from "./run.js";

/**
 * A runner is any command speaking the stdin/stdout contract in run.ts.
 *
 * Paths are relative to this harness directory, so the defaults assume the
 * usual layout: this repository as a submodule at `contract/` in an SDK
 * repository, with the runner at that repository's root. MF_RUNNER and the
 * per-language interpreter variables override that for any other arrangement,
 * which is also how CI points at a freshly built artifact rather than the
 * source tree.
 */
const RUNNERS: Record<string, string[]> = {
  node: [nodeRunner(), process.env["MF_RUNNER"] ?? "runners/node/runner.ts"],
  python: [
    process.env["MF_PYTHON"] ?? "python3",
    process.env["MF_RUNNER"] ?? "../../conformance_runner.py",
  ],
  go: ["go", "run", process.env["MF_RUNNER"] ?? "../../cmd/conformance-runner"],
  java: ["java", "-jar", process.env["MF_RUNNER"] ?? "../../build/conformance/conformance-runner.jar"],
  dotnet: [
    "dotnet",
    process.env["MF_RUNNER"] ??
      "../../tools/ConformanceRunner/bin/Release/net8.0/conformance-runner.dll",
  ],
  ruby: [process.env["MF_RUBY"] ?? "ruby", process.env["MF_RUNNER"] ?? "../../exe/conformance_runner.rb"],
  php: ["php", process.env["MF_RUNNER"] ?? "../../bin/conformance-runner.php"],
};

const name = process.argv[2] ?? "node";
const command = RUNNERS[name];
if (!command) {
  console.error(`unknown runner "${name}". known: ${Object.keys(RUNNERS).join(", ")}`);
  process.exit(2);
}

const scenarios = loadScenarios();
let failed = 0;

console.log(`conformance: ${scenarios.length} scenarios against the ${name} SDK\n`);

for (const s of scenarios) {
  const { failures } = await runScenario(s, command);
  if (failures.length === 0) {
    console.log(`  pass  ${s.id}  ${s.name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${s.id}  ${s.name}`);
    for (const f of failures) console.log(`          ${f}`);
    if (s.why) console.log(`          why this matters: ${s.why}`);
  }
}

console.log(`\n${scenarios.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
