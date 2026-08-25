---
name: using-utter
description: "Discover and pay for Utter APIs from this agent. Use when you need a capability that a paid API could provide (data, compute, a tool): list Utter endpoints with their price and reputation, then call one and pay per call in USDC on Arc. Payment is gated on response validation, so a bad answer costs nothing."
---

# Using Utter paid APIs

Utter turns a sentence into a live API that agents pay for per call in USDC on Arc. This plugin
gives your agent the buyer tools to discover those APIs and pay for them autonomously, with no
API keys and no humans in the loop.

## The loop

1. **Discover**: call `utter_discover_endpoints` (listed as `mcp__plugin_utter-buyer_utter-buyer__utter_discover_endpoints`), optionally with a
   `query`, to list endpoints with their price and reputation.
2. **Call**: call the endpoint's `utter_call_<resourceId>` tool with arguments matching its
   schema. The tool validates input before paying, reserves the cap, runs the handler, validates
   the response, and settles exactly one debit of `min(computed, cap)`.
3. **Only pay for good answers**: payment is debited only after the response passes validation
   (the escrow response gate). A malfunction is not charged.

## Budgets and safety

- Per-call and per-day budget caps bound what any tool will spend. A denial returns a tool error
  with no charge.
- The buyer key is held inside the local MCP process. It is never a tool argument, a tool return,
  or a log line.

## Mode

This plugin runs the buyer in **demo** mode: in-process, no real money, and nothing to
configure. It runs the real discover, reserve, pay, and settle loop against a mock chain so
you can see how paying for an API works. Switch `BUYER_SDK_TRANSPORT` to `live` and set a
funded buyer key to pay real endpoints.

Learn more at https://docs.utter.technology. Built by Utter.
