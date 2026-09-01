# Writing a runner

A runner is a small program that lets the conformance driver operate one SDK.
It is the only thing you write per language. The scenarios, the mock server and
every assertion are shared, so an SDK cannot pass by agreeing with itself.

`runners/node/runner.ts` is the reference. It is about eighty lines, and a
runner in any other language is the same shape.

## The contract

1. Read one scenario as JSON on **stdin**.
2. Construct the SDK against `MARGINFUSE_BASE_URL` and `MARGINFUSE_API_KEY`
   from the environment. Apply `scenario.options.timeoutMs` if present.
3. Register an error hook that appends each call's `context` to a list.
4. Perform `scenario.action`, which is one of `decide`, `track`, `guard`,
   `acknowledge`, with `scenario.params`.
   - For `guard`, pass a fake provider callback that records the `model` and
     `provider` it was invoked with, throws if `scenario.provider.throws` is
     true, and otherwise returns `scenario.provider.usage`.
5. **Flush**, including after the SDK threw. The driver asserts on requests that
   actually arrived, and `guard` records the attempt before it rethrows.
6. Print one JSON report on **stdout** and exit `0`.

Exit non-zero only when the runner itself broke. An SDK misbehaving is a report
for the driver to judge, not a crash.

## The report

```json
{
  "outcome": "returned",
  "threw": "message, only when outcome is threw",
  "result": { },
  "providerCalls": [{ "model": "gpt-4.1-mini", "provider": "openai" }],
  "onErrorContexts": ["decide"]
}
```

`result` is the SDK's return value. For `guard`, send `{ "kind", "decision" }`
only: the application's own result value means nothing to another language.

## Where it is verified

This repository does not depend on any SDK, so a runner is not built or
typechecked here. It is exercised in its own SDK's repository, against that
repository's build, which is the only place the package it imports exists.

## Registering it

Add an entry to `RUNNERS` in `src/cli.ts`:

```ts
const RUNNERS: Record<string, string[]> = {
  node: [nodeRunner(), "runners/node/runner.ts"],
  python: [process.env["MF_PYTHON"] ?? "python3", "../../conformance_runner.py"],
  go: ["go", "run", "../../conformance_runner.go"],
};
```

Paths are relative to the harness directory. The defaults assume this
repository sits at `contract/` in an SDK repository with the runner at that
repository's root. `MF_RUNNER` and the per-language interpreter variables
override it, which is how CI points at a freshly built artifact instead of the
source tree.

Then:

```bash
pnpm --filter @marginfuse/conformance conformance python
```

## What the driver checks

Both halves of every scenario, which is the point. The runner's self-report is
checked against `expect.result`, `expect.providerCalls` and
`expect.onErrorContexts`; independently, the requests the mock server really
received are checked against `expect.requests`. A runner reporting `blocked`
while the mock recorded a provider call fails, however honest its report was.

On top of every scenario, the driver scans every request body that left the
process for a field that could carry prompt content. That check runs against
the bytes on the wire, not against the type that was supposed to shape them.
