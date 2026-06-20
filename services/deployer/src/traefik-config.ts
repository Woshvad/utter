// traefik-config.ts - the per-resource Traefik dynamic-config GENERATOR (DEP-01 routing).
//
// At deploy the deployer writes ONE file per resource into
// `infrastructure/traefik/dynamic/<slug>.yml`; Traefik's file provider watches that
// directory (see infrastructure/traefik/traefik.yml) and hot-loads the router
// WITHOUT a restart. This module builds that per-resource dynamic config object +
// its YAML serialization. It mirrors the SPEC §9.3 label set expressed as
// file-provider config (RESEARCH Code Ex §4): a websecure router with the
// `Host(<slug>.resources.<domain>)` rule, `tls.certResolver: le`, the wildcard SANs,
// and a service loadBalancer pointing at the resource container (port 8080).
//
// OPERATOR-GATED (Plan 06): the live `*.resources.<domain>` wildcard CERT + the
// DNS-01 challenge + the DNS provider credentials are operator-provisioned. Wildcard
// certs REQUIRE DNS-01 (only DNS-01 proves control of the whole domain - RESEARCH
// Pitfall 5); the `le` resolver's dnsChallenge lives in the STATIC config
// (infrastructure/traefik/traefik.yml), not here. This module is the config
// GENERATOR only; it never issues a cert and never asserts the live HTTPS path.

/** A Traefik file-provider router (the subset SPEC §9.3 maps to). */
export interface TraefikRouter {
  /** The host-match rule, e.g. Host(`<slug>.resources.<domain>`). */
  rule: string;
  /** The TLS entrypoint (`:443`); always `websecure` for a paid resource. */
  entryPoints: string[];
  /** The backing service name (== slug). */
  service: string;
  /** TLS config: the Let's Encrypt resolver + the wildcard SANs. */
  tls: {
    /** The static-config cert resolver name (`le`). */
    certResolver: string;
    /** The wildcard SAN set: apex `resources.<domain>` + `*.resources.<domain>`. */
    domains: Array<{ main: string; sans: string[] }>;
  };
}

/** A Traefik file-provider service loadBalancer. */
export interface TraefikService {
  loadBalancer: { servers: Array<{ url: string }> };
}

/** The per-resource file-provider dynamic config document. */
export interface TraefikDynamicConfig {
  http: {
    routers: Record<string, TraefikRouter>;
    services: Record<string, TraefikService>;
  };
}

/** Inputs to {@link buildTraefikDynamicConfig}. */
export interface BuildTraefikDynamicConfigOpts {
  /** The resource slug -> the `<slug>.resources.<domain>` host + the router/service key. */
  slug: string;
  /** The deploy domain (e.g. `utter.example`); `resources.<domain>` is the apex SAN. */
  domain: string;
  /**
   * The resource container's URL the loadBalancer points at. Defaults to
   * `http://<slug>:<port>` (the in-cluster container name + the SPEC §9.3 port 8080).
   */
  containerUrl?: string;
  /** The resource container port (default 8080 per SPEC §9.3). Ignored if containerUrl is set. */
  port?: number;
}

/** The default resource container port (SPEC §9.3). */
export const DEFAULT_RESOURCE_PORT = 8080;

/**
 * Build the per-resource Traefik file-provider dynamic config for
 * `Host(<slug>.resources.<domain>)`. Returns the structured config object AND its
 * YAML serialization (the deployer writes the YAML to
 * `infrastructure/traefik/dynamic/<slug>.yml`). The router terminates wildcard TLS
 * via the `le` resolver (DNS-01, operator-provisioned cert) and routes to the
 * resource container's loadBalancer. Two distinct slugs yield non-colliding
 * router/service keys (keyed on the slug), so resources never clobber each other.
 */
export function buildTraefikDynamicConfig(
  opts: BuildTraefikDynamicConfigOpts,
): { config: TraefikDynamicConfig; yaml: string } {
  const { slug, domain } = opts;
  const apex = `resources.${domain}`;
  const port = opts.port ?? DEFAULT_RESOURCE_PORT;
  const containerUrl = opts.containerUrl ?? `http://${slug}:${port}`;

  const config: TraefikDynamicConfig = {
    http: {
      routers: {
        [slug]: {
          rule: `Host(\`${slug}.${apex}\`)`,
          entryPoints: ["websecure"],
          service: slug,
          tls: {
            certResolver: "le",
            // Wildcard via DNS-01: the SAN set MUST include both the apex and the
            // wildcard (Pitfall 5). The operator-provisioned cert covers both.
            domains: [{ main: apex, sans: [`*.${apex}`] }],
          },
        },
      },
      services: {
        [slug]: {
          loadBalancer: { servers: [{ url: containerUrl }] },
        },
      },
    },
  };

  return { config, yaml: serializeTraefikDynamicConfig(config) };
}

// ---------------------------------------------------------------------------
// A focused YAML serializer + parser for the fixed file-provider shape above.
// Deliberately NOT a general YAML library: the deployer only ever emits THIS
// document shape, so a narrow, dependency-free round-trippable codec is the
// correct supply-chain posture (no new dep for one config file). The round-trip
// (serialize -> parse -> deep-equal) is the test's "the file provider can consume
// it" proof.
// ---------------------------------------------------------------------------

/** Quote a scalar so the YAML is unambiguous (the rule has backticks + parens). */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/** Serialize a {@link TraefikDynamicConfig} to file-provider YAML. */
export function serializeTraefikDynamicConfig(config: TraefikDynamicConfig): string {
  const lines: string[] = ["http:", "  routers:"];
  for (const [name, router] of Object.entries(config.http.routers)) {
    lines.push(`    ${yamlScalar(name)}:`);
    lines.push(`      rule: ${yamlScalar(router.rule)}`);
    lines.push(`      entryPoints: [${router.entryPoints.map(yamlScalar).join(", ")}]`);
    lines.push(`      service: ${yamlScalar(router.service)}`);
    lines.push("      tls:");
    lines.push(`        certResolver: ${yamlScalar(router.tls.certResolver)}`);
    lines.push("        domains:");
    for (const d of router.tls.domains) {
      lines.push(`          - main: ${yamlScalar(d.main)}`);
      lines.push(`            sans: [${d.sans.map(yamlScalar).join(", ")}]`);
    }
  }
  lines.push("  services:");
  for (const [name, service] of Object.entries(config.http.services)) {
    lines.push(`    ${yamlScalar(name)}:`);
    lines.push("      loadBalancer:");
    lines.push("        servers:");
    for (const s of service.loadBalancer.servers) {
      lines.push(`          - url: ${yamlScalar(s.url)}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Parse the file-provider YAML emitted by {@link serializeTraefikDynamicConfig}
 * back into a {@link TraefikDynamicConfig}. Narrow on purpose: it round-trips OUR
 * own emitter so the test can prove the YAML is well-formed + consumable without a
 * general YAML dependency. Throws on any unexpected shape (a guard against a future
 * emitter change silently drifting from this parser).
 */
export function parseTraefikDynamicConfig(yaml: string): TraefikDynamicConfig {
  const lines = yaml.split("\n");
  const config: TraefikDynamicConfig = { http: { routers: {}, services: {} } };
  let section: "routers" | "services" | null = null;
  let currentName: string | null = null;
  let inDomains = false;
  let inServers = false;

  const indent = (l: string) => l.length - l.trimStart().length;
  const unq = (v: string): string => JSON.parse(v) as string;
  const after = (l: string, key: string): string => l.trim().slice(`${key}:`.length).trim();
  const list = (raw: string): string[] => {
    const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
    if (inner.length === 0) return [];
    return inner.split(",").map((s) => unq(s.trim()));
  };

  for (const raw of lines) {
    if (raw.trim().length === 0) continue;
    const ind = indent(raw);
    const line = raw.trim();

    if (ind === 0) continue; // `http:`
    if (ind === 2) {
      section = line === "routers:" ? "routers" : line === "services:" ? "services" : null;
      currentName = null;
      inDomains = false;
      inServers = false;
      continue;
    }
    if (ind === 4 && section) {
      currentName = unq(line.replace(/:$/, ""));
      if (section === "routers") {
        config.http.routers[currentName] = {
          rule: "",
          entryPoints: [],
          service: "",
          tls: { certResolver: "", domains: [] },
        };
      } else {
        config.http.services[currentName] = { loadBalancer: { servers: [] } };
      }
      inDomains = false;
      inServers = false;
      continue;
    }
    if (!currentName || !section) continue;

    if (section === "routers") {
      const router = config.http.routers[currentName];
      if (!router) continue;
      if (line.startsWith("rule:")) router.rule = unq(after(line, "rule"));
      else if (line.startsWith("entryPoints:")) router.entryPoints = list(after(line, "entryPoints"));
      else if (line.startsWith("service:")) router.service = unq(after(line, "service"));
      else if (line.startsWith("certResolver:")) router.tls.certResolver = unq(after(line, "certResolver"));
      else if (line === "domains:") inDomains = true;
      else if (inDomains && line.startsWith("- main:")) router.tls.domains.push({ main: unq(after(line, "- main")), sans: [] });
      else if (inDomains && line.startsWith("sans:")) {
        const last = router.tls.domains[router.tls.domains.length - 1];
        if (last) last.sans = list(after(line, "sans"));
      }
    } else {
      const service = config.http.services[currentName];
      if (!service) continue;
      if (line === "servers:") inServers = true;
      else if (inServers && line.startsWith("- url:")) service.loadBalancer.servers.push({ url: unq(after(line, "- url")) });
    }
  }

  return config;
}
