/**
 * The conformance driver.
 *
 * For every scenario: start a scripted mock, hand its URL to the SDK's runner
 * as a subprocess, and assert on what the runner reported AND on what the mock
 * actually received. Both halves matter. A runner that reports "blocked" while
 * the mock recorded a provider call would pass a self-report and fail here.
 *
 * The runner is a subprocess on purpose: it is the only contract that works the
 * same for TypeScript, Python, Go, Java and the rest. See runners/README.md.
 *
 *   pnpm --filter @marginfuse/conformance conformance node
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockServer, type RecordedRequest, type ScriptedResponse } from "./mock-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const scenarioPath = resolve(here, "../../conformance/behavior-scenarios.json");

export const API_KEY = "mf_test_conformance";

interface ExpectedRequest {
  method: string;
  path: string;
  bodyIncludes?: Record<string, unknown>;
  /** For generated values, which cannot be compared literally. */
  bodyMatches?: Record<string, string>;
  headersInclude?: Record<string, string>;
}

export interface Scenario {
  id: string;
  name: string;
  why?: string;
  options?: { timeoutMs?: number };
  server: Record<string, ScriptedResponse[]>;
  action: "decide" | "track" | "guard" | "acknowledge" | "identify";
  params: Record<string, unknown>;
  provider?: { throws?: boolean; usage?: Record<string, number> };
  expect: {
    throws: boolean;
    result?: Record<string, unknown>;
    providerCalls?: Array<Record<string, unknown>>;
    requests?: ExpectedRequest[];
    /** See the conventions note in the scenario file. */
    requestsUnordered?: boolean;
    onErrorContexts?: string[];
  };
}

/** What every runner, in every language, must print to stdout as one JSON line. */
export interface RunnerReport {
  outcome: "returned" | "threw";
  threw?: string;
  result?: Record<string, unknown>;
  providerCalls?: Array<Record<string, unknown>>;
  onErrorContexts?: string[];
}

export function loadScenarios(): Scenario[] {
  const file = JSON.parse(readFileSync(scenarioPath, "utf8")) as { scenarios: Scenario[] };
  return file.scenarios;
}

/** Every key in `expected` must be present and equal in `actual`. Extra keys are fine. */
function includes(actual: unknown, expected: Record<string, unknown>): string | null {
  if (typeof actual !== "object" || actual === null) return `expected an object, got ${typeof actual}`;
  const obj = actual as Record<string, unknown>;
  for (const [k, v] of Object.entries(expected)) {
    const got = obj[k];
    if (JSON.stringify(got) !== JSON.stringify(v)) {
      return `${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got)}`;
    }
  }
  return null;
}

export function checkScenario(
  s: Scenario,
  report: RunnerReport,
  requests: RecordedRequest[],
): string[] {
  const failures: string[] = [];

  if (s.expect.throws && report.outcome !== "threw") {
    failures.push("expected the SDK to propagate the provider's error, it returned instead");
  }
  if (!s.expect.throws && report.outcome === "threw") {
    failures.push(`the SDK threw into application code: ${report.threw}`);
  }

  if (s.expect.result) {
    const mismatch = includes(report.result, s.expect.result);
    if (mismatch) failures.push(`result ${mismatch}`);
  }

  if (s.expect.providerCalls) {
    const got = report.providerCalls ?? [];
    if (got.length !== s.expect.providerCalls.length) {
      failures.push(
        `expected ${s.expect.providerCalls.length} provider call(s), got ${got.length}` +
          (s.expect.providerCalls.length === 0 ? " (the call it was told not to make)" : ""),
      );
    } else {
      s.expect.providerCalls.forEach((want, i) => {
        const mismatch = includes(got[i], want);
        if (mismatch) failures.push(`providerCalls[${i}] ${mismatch}`);
      });
    }
  }

  if (s.expect.requests) {
    if (requests.length !== s.expect.requests.length) {
      failures.push(
        `expected ${s.expect.requests.length} request(s), got ${requests.length}: ` +
          requests.map((r) => `${r.method} ${r.path}`).join(", "),
      );
    } else {
      // Order is significant by default: an acknowledgment before its decision
      // is a real bug. A scenario opts out only where the API itself documents
      // the pair as order independent, so that requiring an order would force
      // every SDK to serialise background work for a constraint the product
      // does not have.
      const ordered = s.expect.requestsUnordered
        ? matchUnordered(s.expect.requests, requests, failures)
        : requests;
      s.expect.requests.forEach((want, i) => {
        const got = ordered[i] as RecordedRequest;
        if (got === undefined) return;
        if (got.method !== want.method || got.path !== want.path) {
          failures.push(
            `requests[${i}]: expected ${want.method} ${want.path}, got ${got.method} ${got.path}`,
          );
          return;
        }
        if (want.bodyIncludes) {
          // /v1/events wraps the event in a batch; assert against the event.
          const target =
            got.path === "/v1/events"
              ? ((got.body as { events?: unknown[] } | undefined)?.events?.[0] ?? got.body)
              : got.body;
          const mismatch = includes(target, want.bodyIncludes);
          if (mismatch) failures.push(`requests[${i}] body ${mismatch}`);
        }
        if (want.bodyMatches) {
          const target =
            got.path === "/v1/events"
              ? ((got.body as { events?: unknown[] } | undefined)?.events?.[0] ?? got.body)
              : got.body;
          const obj = (target ?? {}) as Record<string, unknown>;
          for (const [k, pattern] of Object.entries(want.bodyMatches)) {
            const value = obj[k];
            if (typeof value !== "string" || !new RegExp(pattern).test(value)) {
              failures.push(
                `requests[${i}] body ${k}: expected a string matching /${pattern}/, got ${JSON.stringify(value)}`,
              );
            }
          }
        }
        if (want.headersInclude) {
          for (const [k, v] of Object.entries(want.headersInclude)) {
            if (got.headers[k.toLowerCase()] !== v) {
              failures.push(
                `requests[${i}] header ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got.headers[k.toLowerCase()])}`,
              );
            }
          }
        }
      });
    }
  }

  if (s.expect.onErrorContexts) {
    const got = (report.onErrorContexts ?? []).slice().sort();
    const want = s.expect.onErrorContexts.slice().sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`onError contexts: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }

  // The privacy claim, checked against the bytes that actually left the process
  // rather than against the type that was supposed to shape them.
  const banned = new Set([
    "prompt",
    "prompts",
    "message",
    "messages",
    "content",
    "text",
    "input",
    "output",
    "completion",
    "response",
    "body",
    "document",
  ]);
  const scan = (node: unknown, path: string): void => {
    if (Array.isArray(node)) return node.forEach((n, i) => scan(n, `${path}[${i}]`));
    if (typeof node !== "object" || node === null) return;
    for (const [k, v] of Object.entries(node)) {
      if (banned.has(k.toLowerCase())) failures.push(`request body carried a content field: ${path}.${k}`);
      scan(v, `${path}.${k}`);
    }
  };
  requests.forEach((r, i) => scan(r.body, `requests[${i}]`));

  return failures;
}

/**
 * Pairs each expectation with the recorded request that matches its method and
 * path, so an unordered scenario still checks bodies and headers per request
 * rather than degrading into a count.
 */
function matchUnordered(
  wants: ExpectedRequest[],
  requests: RecordedRequest[],
  failures: string[],
): Array<RecordedRequest | undefined> {
  const pool = [...requests];
  return wants.map((want) => {
    const index = pool.findIndex((r) => r.method === want.method && r.path === want.path);
    if (index === -1) {
      failures.push(
        `no request matched ${want.method} ${want.path}; got ` +
          requests.map((r) => `${r.method} ${r.path}`).join(", "),
      );
      return undefined;
    }
    return pool.splice(index, 1)[0];
  });
}

/** Drives one scenario end to end. Exported so the vitest suite can reuse it. */
export async function runScenario(
  s: Scenario,
  runnerCommand: string[],
): Promise<{ failures: string[]; requests: RecordedRequest[]; report: RunnerReport }> {
  const mock = await startMockServer(s.server);
  try {
    const report = await driveRunner(runnerCommand, s, mock.baseUrl);
    return { failures: checkScenario(s, report, mock.requests), requests: mock.requests, report };
  } finally {
    await mock.close();
  }
}

function driveRunner(command: string[], s: Scenario, baseUrl: string): Promise<RunnerReport> {
  const [cmd, ...args] = command;
  if (cmd === undefined) throw new Error("empty runner command");

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        MARGINFUSE_BASE_URL: baseUrl,
        MARGINFUSE_API_KEY: API_KEY,
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`runner did not finish within 20s for ${s.id}`));
    }, 20_000);

    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectPromise(new Error(`runner exited ${code} for ${s.id}\n${stderr}`));
        return;
      }
      const line = stdout.trim().split("\n").filter(Boolean).at(-1);
      if (!line) {
        rejectPromise(new Error(`runner printed no report for ${s.id}\n${stderr}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(line) as RunnerReport);
      } catch {
        rejectPromise(new Error(`runner report was not JSON for ${s.id}: ${line}`));
      }
    });

    // The scenario goes in on stdin so a runner needs no argument parsing.
    child.stdin.write(JSON.stringify(s));
    child.stdin.end();
  });
}

/** Local tsx, not `pnpm exec tsx`: 15 scenarios pay the launcher cost 15 times. */
export function nodeRunner(): string {
  return resolve(here, "../node_modules/.bin/tsx");
}
