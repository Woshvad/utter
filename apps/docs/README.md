# @utter/docs

The Utter documentation site. Built with [Mintlify](https://mintlify.com): a `docs.json` config plus MDX pages.

## Local development

```bash
pnpm install
pnpm --filter @utter/docs dev
```

This starts the Mintlify dev server (default `http://localhost:3000`). The first run installs the `mintlify` CLI from the workspace.

## Structure

- `docs.json` sizes the navigation, theme, and brand colors.
- `index.mdx` is the landing page.
- Pages live in folders that mirror the top navigation tabs: `start/`, `create/`, `pay/`, `concepts/`, `reference/`, `operator/`.
- `logo/` and `favicon.svg` hold the brand marks.

## Editing

Every page is MDX. Add a page by creating the file and registering its path (without the extension) in the matching group inside `docs.json`. Keep the house style: plain prose, no em dashes, no filler. Money amounts are USDC base units unless stated otherwise, and Arc is testnet only (chain id `5042002`).

## Deploy

Mintlify builds a static site (`pnpm --filter @utter/docs build`). Point it at `docs.utter.technology` through the same Traefik ingress the other apps use, or connect the repo to a Mintlify project. The MDX content is portable if the site is ever moved to another framework.
