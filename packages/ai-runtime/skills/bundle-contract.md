# The five-file bundle contract

This is the exact per-file shape the platform validator (the four 04-03 gates)
checks. A bundle that deviates is rejected. Mirror the proven echo bundle
(`packages/x402-arc/examples/echo/*`).

## handler.ts

A Hono handler. The reference shape:

```ts
import type { Context } from "hono";
export async function handler(c: Context): Promise<Response> {
  let body: { text?: unknown };
  try {
    body = (await c.req.json()) as { text?: unknown };
  } catch {
    return c.json({ error: "request body must be valid JSON", code: "BAD_JSON" }, 400);
  }
  const text = body?.text;
  if (typeof text !== "string") {
    return c.json({ error: "text must be a string", code: "BAD_INPUT" }, 400);
  }
  return c.json({ result: text, length: text.length }, 200);
}
```

For an upstream call, route through the data-proxy (keyless):

```ts
const upstream = await fetch(process.env.EGRESS_PROXY_URL + "/proxy", {
  method: "POST",
  headers: {
    "x-resource-token": process.env.RESOURCE_TOKEN ?? "",
    "x-resource-id": process.env.RESOURCE_ID ?? "",
    "x-upstream-url": process.env.UPSTREAM_URL ?? "",
    "content-type": "application/json",
  },
  body: JSON.stringify(payload),
});
```

## openapi.json

OpenAPI 3.1, `$id: "openapi.json"`, one success and one documented-error component
schema:

```jsonc
{
  "$id": "openapi.json",
  "openapi": "3.1.0",
  "info": { "title": "<name>", "version": "1.0.0" },
  "paths": { "/": { "post": { "responses": {
    "200": { "description": "Success", "content": { "application/json": {
      "schema": { "$ref": "#/components/schemas/ResourceSuccess" } } } },
    "400": { "description": "Declared error", "content": { "application/json": {
      "schema": { "$ref": "#/components/schemas/ResourceError" } } } }
  } } } },
  "components": { "schemas": {
    "ResourceSuccess": { "type": "object", "additionalProperties": false,
      "required": ["result", "length"],
      "properties": { "result": { "type": "string" }, "length": { "type": "integer", "minimum": 0 } } },
    "ResourceError": { "type": "object", "additionalProperties": false,
      "required": ["error"],
      "properties": { "error": { "type": "string" }, "code": { "type": "string" } } }
  } }
}
```

## test-cases.json

At least one case each of success / declared_error / malfunction:

```jsonc
{
  "description": "<resource> fixtures the gate classifies.",
  "cases": [
    { "label": "success", "input": { "text": "hi" },
      "response": { "result": "hi", "length": 2 }, "expectedClass": "success" },
    { "label": "declared_error", "input": { "text": 123 },
      "response": { "error": "text must be a string", "code": "BAD_INPUT" }, "expectedClass": "declared_error" },
    { "label": "malfunction", "input": { "text": "hi" },
      "response": { "unexpected": "x", "length": "nope" }, "expectedClass": "malfunction" }
  ]
}
```

## agent-card.json and Dockerfile

Emit minimal placeholders. The platform overwrites `agent-card.json` with the
canonical A2A v0.3.0 card and `Dockerfile` with the digest-pinned hardened build.
Never author a `FROM` line.
