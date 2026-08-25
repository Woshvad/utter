---
description: "List paid Utter API endpoints with their price and reputation."
argument-hint: "[query]"
---

Call the `utter_discover_endpoints` tool (pass `$ARGUMENTS` as the `query` when it is non-empty) and present the endpoints as a short
table of name, price (USDC base units), and reputation. Then ask which one to call, or, if the
user already named a task, pick the best-fit endpoint and call its `utter_call_<resourceId>` tool.
