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
