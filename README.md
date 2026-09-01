# MarginFuse SDK contract

The machine-readable definition of how every [MarginFuse](https://marginfuse.com)
SDK behaves, in every language.

An SDK that passes what is in this repository agrees with the API and with the
other SDKs. One that does not, does not, whatever its own tests say.

```
openapi.json                          the /v1 HTTP surface, OpenAPI 3.1
conformance/gateway-vectors.json      golden input and output pairs for the gateway adapters
conformance/behavior-scenarios.json   scenarios every SDK is driven through
harness/                              the driver, the mock server, and the runner contract
```

## Why this exists

MarginFuse sits in the request path of somebody else's product and holds their
API key. It decides whether an AI call runs at all. An SDK that gets this wrong
does not throw an error, it quietly overcharges a customer or fails a request
that should have succeeded.

Ten SDKs written from ten readings of a prose document would disagree within a
month. So none of them are written from prose. Every expectation lives here, as
data, and every SDK reads it.

## openapi.json

Generated from the Zod schemas the API validates production traffic against, so
it cannot describe an endpoint that is not served. Also available live at
[api.marginfuse.com/openapi.json](https://api.marginfuse.com/openapi.json).

Four routes, which is the whole reason ten languages is tractable:

```
POST /v1/events                 batch ingest, idempotent on eventId
POST /v1/decisions              allow | downgrade | topup_required | block
POST /v1/decisions/{id}/ack     what the application actually did
GET  /health
```

## conformance/gateway-vectors.json

Gateway adapters map a provider's usage object to MarginFuse fields. They are
pure functions with no I/O, which makes them look like the easiest thing to port
and makes them the easiest thing to get silently wrong. `fromOpenRouter` alone
carries two hazards that misstate margin without raising anything:

- `prompt_tokens` is a **total** that already contains cached reads and cache
  writes. MarginFuse prices those as three separate charges, so a port that
  passes the total through charges every cached token twice at the full rate.
- `cost` must be formatted fixed point. `String()`, `str()`, `to_s` and
  `FormatFloat` with `'g'` all emit `1.2e-7` for the small costs cheap models
  produce, and the API rejects that.

Port against the vectors. Not by eye.

## conformance/behavior-scenarios.json

Where the vectors cover arithmetic, these cover the promise an SDK makes to the
application it sits inside: **it never breaks the caller, and it never runs a
provider call it was told not to run.**

Each scenario scripts a mock MarginFuse and states two things separately: what
the SDK must return, and what requests must actually have reached the server. An
SDK reporting `blocked` while the mock recorded a provider call fails, however
honest its own report was.

Every scenario additionally scans the request bodies that really left the
process for any field that could carry prompt content, so the privacy claim is
checked against the bytes on the wire rather than the type meant to shape them.

## Running it

```bash
cd harness
npm install
npm run conformance node
```

```
conformance: 15 scenarios against the node SDK

  pass  decide-allow  an allow verdict runs the provider with the requested model
  pass  block-never-calls-provider  a block verdict never calls the provider
  ...
  15 passed, 0 failed
```

## Adding a language

Write one runner: a program that reads a scenario as JSON on stdin, drives your
SDK, and prints one report on stdout. The Node reference is about eighty lines.
The driver, the mock and every assertion are shared, so you never touch them.

See [harness/runners/README.md](harness/runners/README.md).

## Using it from an SDK repository

Add this repository as a submodule so the pinned commit proves which contract
your SDK was verified against:

```bash
git submodule add https://github.com/marginfuse/sdk-contract contract
```

## License

MIT
