# @utter/plugin-gen

Turn published Utter endpoints into an installable Claude Code plugin marketplace. Each endpoint
becomes a plugin whose bundled buyer MCP lets an agent discover, pay for, and call it through the
escrow response gate. This is the distribution bridge: a sentence becomes a paid API, and a paid
API becomes a one-command-installable agent tool.

## What it emits

- `.claude-plugin/marketplace.json` listing every plugin.
- A base `utter-buyer` plugin: discovery plus pay tools for any endpoint. Demo mode by default,
  so it boots with no configuration and runs the full escrow loop in-process.
- One `utter-<slug>` plugin per endpoint: the buyer MCP scoped to that one resource id, plus a
  skill describing the endpoint, its price, and how to call it.

The generator is pure text and config. It authors no money field and holds no key. The buyer SDK
re-pins escrow, asset, payTo, and cap against the trusted on-chain constants before signing, so a
stale or wrong marketplace row can never cause a bad payment.

## CLI

```bash
# From the live marketplace index (add --enrich for real descriptions)
pnpm --filter @utter/plugin-gen generate -- \
  --marketplace-url https://<marketplace-host> --out ../../ --local --prune --enrich

# From a single endpoint's agent card
pnpm --filter @utter/plugin-gen generate -- \
  --card https://<slug>.resources.<domain>/.well-known/agent-card.json --out ../../ --local --prune
```

Flags: `--marketplace-url`, `--card` (repeatable), `--source <file>`, `--out`, `--local` |
`--published`, `--prune`, `--no-base`, `--name`, `--owner`, `--plugin-root`, `--base-mode`,
`--endpoint-mode`, `--enrich`.

- `--local` launches the buyer MCP from the workspace via `${CLAUDE_PROJECT_DIR}` (works today,
  no npm publish; Windows-safe launcher).
- `--published` launches via `npx -y @utter/buyer-sdk utter-buyer-mcp` (for external installs;
  requires publishing the buyer SDK).

## Library

```ts
import { buildMarketplace, resourceFromAgentCard, writeFiles } from "@utter/plugin-gen";

const resources = [resourceFromAgentCard(card)];
const market = buildMarketplace(resources, { mcp: localMcp() });
await writeFiles(outDir, market.files, { prune: ["plugins"] });
```

See the docs: https://docs.utter.technology/operator/plugin-marketplace
