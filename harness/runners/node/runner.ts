/**
 * The Node conformance runner, and the reference for every other language.
 *
 * The whole contract:
 *   1. read one scenario as JSON on stdin
 *   2. build the SDK against MARGINFUSE_BASE_URL / MARGINFUSE_API_KEY
 *   3. perform scenario.action
 *   4. flush, so queued background work lands before the driver asserts
 *   5. print one JSON report line on stdout, exit 0
 *
 * Exit non-zero only if the runner itself broke. An SDK misbehaving is a report
 * the driver judges, not a crash here.
 */

import { MarginFuse } from "marginfuse";
import type { DecideParams, TrackParams } from "marginfuse";

interface Scenario {
  action: "decide" | "track" | "guard" | "acknowledge";
  options?: { timeoutMs?: number };
  params: Record<string, unknown>;
  provider?: { throws?: boolean; usage?: Record<string, number> };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const scenario = JSON.parse(await readStdin()) as Scenario;

  const providerCalls: Array<Record<string, unknown>> = [];
  const onErrorContexts: string[] = [];

  const mf = new MarginFuse({
    apiKey: process.env["MARGINFUSE_API_KEY"] ?? "",
    baseUrl: process.env["MARGINFUSE_BASE_URL"] ?? "",
    ...(scenario.options?.timeoutMs !== undefined ? { timeoutMs: scenario.options.timeoutMs } : {}),
    onError: (_err, context) => onErrorContexts.push(context),
  });

  const report: Record<string, unknown> = { outcome: "returned" };

  try {
    switch (scenario.action) {
      case "decide": {
        report["result"] = await mf.decide(scenario.params as unknown as DecideParams);
        break;
      }
      case "track": {
        mf.track(scenario.params as unknown as TrackParams);
        break;
      }
      case "acknowledge": {
        const { decisionId, acknowledgment } = scenario.params as {
          decisionId: string;
          acknowledgment: Parameters<MarginFuse["acknowledge"]>[1];
        };
        mf.acknowledge(decisionId, acknowledgment);
        break;
      }
      case "guard": {
        const out = await mf.guard(scenario.params as unknown as DecideParams, async (ctx) => {
          providerCalls.push({ model: ctx.model, provider: ctx.provider });
          if (scenario.provider?.throws === true) throw new Error("provider exploded");
          return { result: "ok", usage: scenario.provider?.usage ?? {} };
        });
        // Only the discriminant and the decision travel; `result` is the
        // application's own value and means nothing to another language.
        report["result"] = { kind: out.kind, decision: out.decision };
        break;
      }
    }
  } catch (err) {
    report["outcome"] = "threw";
    report["threw"] = (err as Error).message;
  }

  // Always flush, including after a throw: the driver asserts on what the SDK
  // sent, and guard() records the attempt before it rethrows.
  await mf.flush();

  report["providerCalls"] = providerCalls;
  report["onErrorContexts"] = onErrorContexts;
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
