---
name: return-the-current-utc-time-as-json
description: "return-the-current-utc-time-as-json: return the current utc time as json. A paid Utter API on Arc that agents call and pay for per call in USDC through the escrow response gate (you are charged only after the response passes validation). Price: base 10000 + 0/KB, cap 10000 (metered, USDC base units) per call. Use this when you need: return the current utc time as json."
---

# return-the-current-utc-time-as-json

return the current utc time as json

This is a paid Utter API. Agents discover it, pay per call in USDC on Arc, and receive the
response only after payment. Payment is debited **only after the response passes validation**
(the escrow response gate), so a bad answer costs nothing.

## How to call it

Use the tool **`utter_call_f8fa3ed7e7443ca91838eb6ecb7b35473c2d2452b9c2913d787617bcfa54f5ce`** exposed by this plugin's `utter-buyer` MCP server
(Claude lists it as `mcp__plugin_utter-return-the-current-utc-time-as-json_utter-buyer__utter_call_f8fa3ed7e7443ca91838eb6ecb7b35473c2d2452b9c2913d787617bcfa54f5ce`).

- Input: the endpoint's request schema is derived from its OpenAPI. If it declares no request
  body schema, pass your JSON payload under an `args` object.
- The tool validates your input before paying (reject before pay), reserves the per-call cap,
  runs the handler, validates the response, then settles exactly one debit of
  `min(computed, cap)` split between the creator and the platform.
- To browse related endpoints, use `utter_discover_endpoints`.

## Price and reputation

- Price: base 10000 + 0/KB, cap 10000 (metered, USDC base units) per call.
- Cap: 10000 USDC base units is the on-chain hard bound for a single call.
- Reputation: unverified, agentId pending, no bond.
- resourceId: `0xf8fa3ed7e7443ca91838eb6ecb7b35473c2d2452b9c2913d787617bcfa54f5ce`

## Setup

This endpoint is live and paid. Before the first call, configure the plugin:

1. `buyer_private_key`: a funded Arc testnet buyer key (kept only inside the local MCP process).
2. `marketplace_url`: the Utter marketplace base URL used for discovery.

Payments settle on Arc through the escrow contract. The live buyer path is operator-gated;
see the docs for provisioning.

## Safety

- The buyer key stays inside the local MCP process. It is never a tool argument, a tool return,
  or a log line.
- Per-call and per-day budget caps bound spend. A cap denial returns a tool error with no charge.

Learn more at https://docs.utter.technology. Built by Utter on https://app.utter.technology.
