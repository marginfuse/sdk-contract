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

const RUNNERS: Record<string, string[]> = {
  node: [nodeRunner(), "runners/node/runner.ts"],
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
