/**
 * The scripted MarginFuse a conformance run talks to.
 *
 * It answers exactly what a scenario tells it to and records exactly what it
 * received, so an assertion can be made about the requests an SDK really sent
 * rather than about what its own return value claims it sent.
 *
 * Deliberately not a partial reimplementation of the real API: it has no
 * validation and no logic, because a mock with behavior of its own is a second
 * thing that can be wrong.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface ScriptedResponse {
  status?: number;
  body?: unknown;
  /** Sent verbatim instead of JSON, for the malformed-response scenarios. */
  raw?: string;
  /** Holds the response open, for the timeout and flush scenarios. */
  delayMs?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  rawBody: string;
}

export interface MockServer {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

/**
 * @param script keyed `METHOD /path`; the list is consumed in order and the
 * last entry repeats, so a retry scenario can fail twice and then succeed.
 */
export async function startMockServer(script: Record<string, ScriptedResponse[]>): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const consumed = new Map<string, number>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      const key = `${req.method ?? "GET"} ${path}`;

      let body: unknown = undefined;
      try {
        body = rawBody === "" ? undefined : JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }

      requests.push({
        method: req.method ?? "GET",
        path,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]),
        ),
        body,
        rawBody,
      });

      const scripted = script[key];
      if (!scripted || scripted.length === 0) {
        // An unscripted route is a scenario bug, not an SDK bug. Say which.
        res.writeHead(551, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no_script_for", key }));
        return;
      }

      const seen = consumed.get(key) ?? 0;
      consumed.set(key, seen + 1);
      const step = scripted[Math.min(seen, scripted.length - 1)] as ScriptedResponse;

      const send = (): void => {
        if (step.raw !== undefined) {
          res.writeHead(step.status ?? 200, { "content-type": "application/json" });
          res.end(step.raw);
          return;
        }
        res.writeHead(step.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(step.body ?? {}));
      };

      if (step.delayMs !== undefined && step.delayMs > 0) {
        setTimeout(send, step.delayMs);
      } else {
        send();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
