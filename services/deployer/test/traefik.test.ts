// traefik.test.ts - the per-resource Traefik dynamic-config generator (DEP-01 routing).
//
// Proves the deployer emits SPEC §9.3-matching file-provider dynamic config for
// `Host(<slug>.resources.<domain>)`:
//   1. the router carries the Host(...) rule, entryPoint `websecure`, service name,
//      and `tls.certResolver: le` (the Let's Encrypt resolver);
//   2. the router's `tls.domains` carries the wildcard SANs (apex + *.resources.<domain>)
//      - wildcard via DNS-01 (RESEARCH Pitfall 5);
//   3. the service loadBalancer points at the resource container URL (port 8080,
//      SPEC §9.3);
//   4. two different slugs produce non-colliding router/service names;
//   5. the emitted YAML round-trips through the matching parser (the file provider
//      can consume it).
//
// AUTONOMOUS: the generator is pure (no live cert, no DNS, no Traefik). The live
// wildcard cert + DNS-01 + the HTTPS 402->200 over `*.resources.<domain>` are
// operator-provisioned (Plan 06); here we assert the GENERATED config only.
import { describe, it, expect } from "vitest";
import {
  buildTraefikDynamicConfig,
  parseTraefikDynamicConfig,
  validateSlug,
  RESERVED_SLUGS,
  SLUG_PATTERN,
} from "../src/traefik-config";

const DOMAIN = "utter.example";

describe("traefik-config", () => {
  it("emits a websecure router with Host(...) rule + tls.certResolver le", () => {
    const { config } = buildTraefikDynamicConfig({
      slug: "weather-bot",
      domain: DOMAIN,
      containerUrl: "http://weather-bot-container:8080",
    });
    const router = config.http.routers["weather-bot"]!;
    expect(router.rule).toBe("Host(`weather-bot.resources.utter.example`)");
    expect(router.entryPoints).toEqual(["websecure"]);
    expect(router.service).toBe("weather-bot");
    expect(router.tls.certResolver).toBe("le");
  });

  it("carries the wildcard SANs (apex + *.resources.<domain>) for the DNS-01 cert", () => {
    const { config } = buildTraefikDynamicConfig({
      slug: "weather-bot",
      domain: DOMAIN,
      containerUrl: "http://weather-bot-container:8080",
    });
    const domains = config.http.routers["weather-bot"]!.tls.domains;
    expect(domains).toEqual([
      { main: "resources.utter.example", sans: ["*.resources.utter.example"] },
    ]);
  });

  it("points the service loadBalancer at the container URL (port 8080 default)", () => {
    const { config } = buildTraefikDynamicConfig({
      slug: "weather-bot",
      domain: DOMAIN,
      // no explicit containerUrl: derived from slug + default port 8080
    } as { slug: string; domain: string });
    const servers = config.http.services["weather-bot"]!.loadBalancer.servers;
    expect(servers).toEqual([{ url: "http://weather-bot:8080" }]);
  });

  it("honors an explicit containerUrl + custom port when provided", () => {
    const { config } = buildTraefikDynamicConfig({
      slug: "weather-bot",
      domain: DOMAIN,
      containerUrl: "http://10.0.0.5:9000",
    });
    expect(config.http.services["weather-bot"]!.loadBalancer.servers).toEqual([
      { url: "http://10.0.0.5:9000" },
    ]);
  });

  it("produces non-colliding router/service names for two different slugs", () => {
    const a = buildTraefikDynamicConfig({ slug: "alpha", domain: DOMAIN });
    const b = buildTraefikDynamicConfig({ slug: "beta", domain: DOMAIN });
    expect(Object.keys(a.config.http.routers)).toEqual(["alpha"]);
    expect(Object.keys(b.config.http.routers)).toEqual(["beta"]);
    expect(Object.keys(a.config.http.services)).toEqual(["alpha"]);
    expect(Object.keys(b.config.http.services)).toEqual(["beta"]);
    expect(a.config.http.routers["alpha"]!.rule).not.toBe(
      b.config.http.routers["beta"]!.rule,
    );
  });

  it("round-trips through the file-provider YAML parser (consumable config)", () => {
    const { config, yaml } = buildTraefikDynamicConfig({
      slug: "weather-bot",
      domain: DOMAIN,
      containerUrl: "http://weather-bot-container:8080",
    });
    expect(typeof yaml).toBe("string");
    const parsed = parseTraefikDynamicConfig(yaml);
    expect(parsed).toEqual(config);
  });
});

describe("traefik-config - slug validation (M5, routing-boundary guard)", () => {
  it("exports the validator + the pattern", () => {
    expect(typeof validateSlug).toBe("function");
    expect(SLUG_PATTERN.source).toBe("^[a-z0-9-]+$");
  });

  it("accepts a valid slug ([a-z0-9-]) and returns it unchanged", () => {
    expect(validateSlug("weather-bot")).toBe("weather-bot");
    expect(validateSlug("echo")).toBe("echo");
    expect(validateSlug("res-123")).toBe("res-123");
  });

  it("a valid slug builds a config keyed on the same validated token", () => {
    const { config } = buildTraefikDynamicConfig({ slug: "weather-bot", domain: DOMAIN });
    expect(Object.keys(config.http.routers)).toEqual(["weather-bot"]);
    expect(config.http.routers["weather-bot"]!.rule).toBe(
      "Host(`weather-bot.resources.utter.example`)",
    );
    expect(config.http.services["weather-bot"]!.loadBalancer.servers).toEqual([
      { url: "http://weather-bot:8080" },
    ]);
  });

  it.each([
    ["a dotted slug (extra DNS label / Host() collision surface)", "bad.slug"],
    ["an uppercase slug", "BadSlug"],
    ["a slug with a space", "bad slug"],
    ["a slug with a slash", "bad/slug"],
    ["an underscore slug", "bad_slug"],
    ["an empty slug", ""],
  ])("rejects %s", (_label, slug) => {
    expect(() => validateSlug(slug)).toThrow(/invalid slug/);
  });

  it("buildTraefikDynamicConfig throws on an invalid slug (cannot mint a colliding router)", () => {
    expect(() => buildTraefikDynamicConfig({ slug: "bad.slug", domain: DOMAIN })).toThrow(
      /invalid slug/,
    );
  });
});

describe("traefik-config - reserved-slug denylist (H2, control-plane router guard)", () => {
  it("exports the reserved set covering the operator dynamic-file basenames", () => {
    // The operator router files in infrastructure/traefik/dynamic are studio.yml and
    // marketplace.yml; a creator slug matching either would overwrite that router.
    expect(RESERVED_SLUGS.has("studio")).toBe(true);
    expect(RESERVED_SLUGS.has("marketplace")).toBe(true);
  });

  it.each([
    ["the operator studio router", "studio"],
    ["the operator marketplace router", "marketplace"],
    ["the traefik infra name", "traefik"],
    ["the api infra name", "api"],
    ["the app infra name", "app"],
    ["the dashboard infra name", "dashboard"],
    ["the ping infra name", "ping"],
    ["the health infra name", "health"],
  ])("rejects %s as a reserved slug", (_label, slug) => {
    expect(() => validateSlug(slug)).toThrow(/reserved/);
  });

  it("buildTraefikDynamicConfig refuses a reserved slug (cannot clobber an operator router)", () => {
    expect(() => buildTraefikDynamicConfig({ slug: "marketplace", domain: DOMAIN })).toThrow(
      /reserved/,
    );
  });

  it("still accepts a non-reserved charset-valid slug", () => {
    expect(validateSlug("weather-bot")).toBe("weather-bot");
  });
});
