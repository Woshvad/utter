// service-runspec.test.ts - the long-lived resource-service profile invariants
// (RESOURCE-DEPLOY-DESIGN §2.2/§2.3). NO container is launched. Asserts the
// service spec keeps EVERY isolation flag identical to the one-shot spec, has NO
// timeoutSeconds field, validates the four relaxed deployment fields, and that
// the dockerode translation carries the named network + restart policy + port.
import { describe, expect, it } from "vitest";
import { buildRunSpec, type RunLimits } from "../src/runner/runspec";
import {
  DEFAULT_SERVICE_RESTART_POLICY,
  buildResourceServiceSpec,
  buildTrustedServiceSpec,
  type BuildResourceServiceSpecOptions,
} from "../src/runner/service-runspec";
import { ServiceEnvViolation } from "../src/runner/service-env";
import { toServiceDockerodeCreateOptions } from "../src/runner/service-dockerode-spec";
import type { RunBackend } from "../src/runner/types";

const LIMITS: RunLimits = {
  pidsLimit: 128,
  memoryBytes: 256 * 1024 * 1024,
  cpus: 0.5,
  storageOptSize: "512m",
};

const baseOpts = (
  backend: RunBackend,
  over: Partial<BuildResourceServiceSpecOptions> = {},
): BuildResourceServiceSpecOptions => ({
  backend,
  image: "resource:abc123",
  limits: LIMITS,
  network: "ingress",
  env: { FACILITATOR_URL: "https://facilitator.controlplane", PORT: "8080" },
  name: "utter_res_echo-1",
  port: 8080,
  ...over,
});

const buildService = (backend: RunBackend) => buildResourceServiceSpec(baseOpts(backend));

describe("service-runspec - isolation flags identical to the one-shot spec", () => {
  for (const backend of ["gvisor", "docker-dev"] as const) {
    describe(backend, () => {
      it("keeps runtime, RO root, capDrop ALL, capAdd [], no-new-privileges identical", () => {
        const one = buildRunSpec({
          backend,
          image: "resource:abc123",
          limits: LIMITS,
          maxTimeoutSeconds: 30,
        });
        const svc = buildService(backend);

        expect(svc.runtime).toBe(one.runtime); // runsc for gvisor, runc for docker-dev
        expect(svc.readonlyRootfs).toBe(one.readonlyRootfs);
        expect(svc.capDrop).toEqual(one.capDrop);
        expect(svc.capDrop).toEqual(["ALL"]);
        expect(svc.capAdd).toEqual(one.capAdd);
        expect(svc.capAdd).toEqual([]);
        expect(svc.securityOpt).toEqual(one.securityOpt);
        expect(svc.tmpfs).toEqual(one.tmpfs);
        expect(svc.pidsLimit).toBe(one.pidsLimit);
        expect(svc.memoryBytes).toBe(one.memoryBytes);
        expect(svc.cpus).toBe(one.cpus);
      });

      it("NEVER carries privileged:true or host networking", () => {
        const svc = buildService(backend) as unknown as Record<string, unknown>;
        expect(svc["privileged"]).toBeUndefined();
        expect(JSON.stringify(svc)).not.toContain('"privileged":true');
        expect(svc["network"]).not.toBe("host");
      });
    });
  }

  it("gvisor service runtime is runsc (the gVisor boundary is never dropped)", () => {
    expect(buildService("gvisor").runtime).toBe("runsc");
  });
});

describe("service-runspec - no auto-kill (enforced by absence)", () => {
  it("has NO timeoutSeconds field at all", () => {
    const svc = buildService("gvisor") as unknown as Record<string, unknown>;
    expect("timeoutSeconds" in svc).toBe(false);
    expect(svc["timeoutSeconds"]).toBeUndefined();
    expect(JSON.stringify(svc)).not.toContain("timeoutSeconds");
  });
});

describe("service-runspec - the four relaxed deployment fields", () => {
  it("network is the given named net", () => {
    expect(buildResourceServiceSpec(baseOpts("gvisor", { network: "controlplane" })).network).toBe(
      "controlplane",
    );
  });

  it("THROWS on network 'host'", () => {
    expect(() => buildResourceServiceSpec(baseOpts("gvisor", { network: "host" }))).toThrow(/host/);
  });

  it("THROWS on network 'none'", () => {
    expect(() => buildResourceServiceSpec(baseOpts("gvisor", { network: "none" }))).toThrow(/none/);
  });

  it("THROWS on an empty network", () => {
    expect(() => buildResourceServiceSpec(baseOpts("gvisor", { network: "" }))).toThrow(/network/);
  });

  it("enforces the name regex ^utter_res_[a-z0-9-]+$", () => {
    expect(() => buildResourceServiceSpec(baseOpts("gvisor", { name: "utter_res_ok-1" }))).not.toThrow();
    for (const bad of ["echo-1", "utter_res_", "Utter_res_x", "utter_res_BAD", "../utter_res_x"]) {
      expect(() => buildResourceServiceSpec(baseOpts("gvisor", { name: bad }))).toThrow(/name/);
    }
  });

  it("defaults restartPolicy to on-failure with a max-retry cap (review H4)", () => {
    const svc = buildService("gvisor");
    expect(svc.restartPolicy).toEqual(DEFAULT_SERVICE_RESTART_POLICY);
    expect(svc.restartPolicy.name).toBe("on-failure");
    expect(svc.restartPolicy.maxRetryCount).toBeGreaterThan(0);
  });

  it("honours a restartPolicy override", () => {
    const svc = buildResourceServiceSpec(
      baseOpts("gvisor", { restartPolicy: { name: "unless-stopped" } }),
    );
    expect(svc.restartPolicy).toEqual({ name: "unless-stopped" });
  });

  it("env is the allowlisted map and rejects a secret-shaped value", () => {
    const svc = buildService("gvisor");
    expect(svc.env).toEqual({ FACILITATOR_URL: "https://facilitator.controlplane", PORT: "8080" });
    expect(() =>
      buildResourceServiceSpec(baseOpts("gvisor", { env: { FACILITATOR_URL: "0x" + "a".repeat(64) } })),
    ).toThrow();
  });
});

describe("service-runspec - extraNetworks (additive multi-network membership)", () => {
  it("carries extraNetworks onto the spec as a readonly copy", () => {
    const svc = buildResourceServiceSpec(
      baseOpts("gvisor", { extraNetworks: ["controlplane", "proxynet"] }),
    );
    expect(svc.extraNetworks).toEqual(["controlplane", "proxynet"]);
    // The primary network is unchanged by extras.
    expect(svc.network).toBe("ingress");
  });

  it("THROWS when an extra net is 'host'", () => {
    expect(() =>
      buildResourceServiceSpec(baseOpts("gvisor", { extraNetworks: ["host"] })),
    ).toThrow(/host/);
  });

  it("THROWS when an extra net is 'none'", () => {
    expect(() =>
      buildResourceServiceSpec(baseOpts("gvisor", { extraNetworks: ["none"] })),
    ).toThrow(/none/);
  });

  it("THROWS when an extra net is empty", () => {
    expect(() =>
      buildResourceServiceSpec(baseOpts("gvisor", { extraNetworks: [""] })),
    ).toThrow(/extraNetworks/);
  });

  it("THROWS when an extra net duplicates the primary network", () => {
    expect(() =>
      buildResourceServiceSpec(
        baseOpts("gvisor", { network: "ingress", extraNetworks: ["ingress"] }),
      ),
    ).toThrow(/duplicate/);
  });

  it("omitting extraNetworks leaves the spec isolation-identical (no regression)", () => {
    const withExtras = buildResourceServiceSpec(
      baseOpts("gvisor", { extraNetworks: ["controlplane"] }),
    );
    const without = buildResourceServiceSpec(baseOpts("gvisor"));
    // No extraNetworks field at all when absent (additive, not a default).
    expect("extraNetworks" in without).toBe(false);
    expect(without.extraNetworks).toBeUndefined();
    // Every isolation-relevant field is identical with or without extras.
    expect(without.runtime).toBe(withExtras.runtime);
    expect(without.readonlyRootfs).toBe(withExtras.readonlyRootfs);
    expect(without.capDrop).toEqual(withExtras.capDrop);
    expect(without.capAdd).toEqual(withExtras.capAdd);
    expect(without.securityOpt).toEqual(withExtras.securityOpt);
    expect(without.tmpfs).toEqual(withExtras.tmpfs);
    expect(without.pidsLimit).toBe(withExtras.pidsLimit);
    expect(without.memoryBytes).toBe(withExtras.memoryBytes);
    expect(without.cpus).toBe(withExtras.cpus);
    expect(without.network).toBe(withExtras.network);
  });

  it("the dockerode NetworkMode is the primary only (extras are connect-only)", () => {
    // Use extra-net names that do NOT appear in any other field so a substring
    // check is unambiguous (the default env FACILITATOR_URL would otherwise
    // contain 'controlplane').
    const svc = buildResourceServiceSpec(
      baseOpts("gvisor", {
        env: { PORT: "8080" },
        network: "ingress",
        extraNetworks: ["zzz-extra-a", "zzz-extra-b"],
      }),
    );
    const opts = toServiceDockerodeCreateOptions(svc);
    expect(opts.HostConfig?.NetworkMode).toBe("ingress");
    // extraNetworks do NOT leak into the create-options (they are post-create connects).
    expect(JSON.stringify(opts)).not.toContain("zzz-extra-a");
    expect(JSON.stringify(opts)).not.toContain("zzz-extra-b");
  });
});

describe("service-runspec - misconfiguration guards", () => {
  it("rejects a non-positive port", () => {
    expect(() => buildResourceServiceSpec(baseOpts("gvisor", { port: 0 }))).toThrow(/port/);
  });
  it("rejects a missing image", () => {
    expect(() => buildResourceServiceSpec(baseOpts("gvisor", { image: "" }))).toThrow(/image/);
  });
  it("rejects a non-positive memory limit", () => {
    expect(() =>
      buildResourceServiceSpec(baseOpts("gvisor", { limits: { ...LIMITS, memoryBytes: 0 } })),
    ).toThrow(/memoryBytes/);
  });
});

describe("service-dockerode-spec - translation carries the relaxed fields + hardening", () => {
  it("maps name, named network, restart policy, exposed port and the hardening block", () => {
    const svc = buildService("gvisor");
    const opts = toServiceDockerodeCreateOptions(svc);

    expect(opts.name).toBe("utter_res_echo-1");
    expect(opts.HostConfig?.Runtime).toBe("runsc");
    expect(opts.HostConfig?.NetworkMode).toBe("ingress");
    expect(opts.HostConfig?.ReadonlyRootfs).toBe(true);
    expect(opts.HostConfig?.CapDrop).toEqual(["ALL"]);
    expect(opts.HostConfig?.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(opts.HostConfig?.RestartPolicy).toEqual({ Name: "on-failure", MaximumRetryCount: 5 });
    expect(opts.ExposedPorts).toEqual({ "8080/tcp": {} });
    expect(opts.Env).toEqual([
      "FACILITATOR_URL=https://facilitator.controlplane",
      "PORT=8080",
    ]);
    // Never privileged, never host networking.
    expect(opts.HostConfig?.Privileged).toBeUndefined();
    expect(opts.HostConfig?.NetworkMode).not.toBe("host");
  });

  it("omits MaximumRetryCount for an unless-stopped policy", () => {
    const svc = buildResourceServiceSpec(
      baseOpts("gvisor", { restartPolicy: { name: "unless-stopped" } }),
    );
    expect(toServiceDockerodeCreateOptions(svc).HostConfig?.RestartPolicy).toEqual({
      Name: "unless-stopped",
    });
  });
});

describe("service-runspec - buildTrustedServiceSpec (first-party sidecar env relaxation)", () => {
  // A secret-shaped env the UNTRUSTED builder rejects (SIDECAR_FACILITATOR_TOKEN
  // trips the *_TOKEN key-name denylist), plus the sidecar's non-secret config.
  const SIDECAR_ENV = {
    SIDECAR_FACILITATOR_TOKEN: "abc.def",
    FACILITATOR_URL: "http://f:8787",
    HANDLER_URL: "http://h:8080",
  };

  it("ACCEPTS a secret-shaped env the untrusted builder rejects and carries it verbatim", () => {
    const svc = buildTrustedServiceSpec(baseOpts("gvisor", { env: SIDECAR_ENV }));
    // The trusted path admits the raw env unchanged - including the token.
    expect(svc.env).toEqual(SIDECAR_ENV);
    expect(svc.env["SIDECAR_FACILITATOR_TOKEN"]).toBe("abc.def");
  });

  it("returns a copy of env, not the caller's map (no aliasing)", () => {
    const opts = baseOpts("gvisor", { env: SIDECAR_ENV });
    const svc = buildTrustedServiceSpec(opts);
    expect(svc.env).not.toBe(opts.env);
    expect(svc.env).toEqual(opts.env);
  });

  it("REGRESSION: buildResourceServiceSpec STILL throws ServiceEnvViolation for the same token env", () => {
    expect(() => buildResourceServiceSpec(baseOpts("gvisor", { env: SIDECAR_ENV }))).toThrow(
      ServiceEnvViolation,
    );
    // And the violation names the offending key without leaking its value.
    try {
      buildResourceServiceSpec(baseOpts("gvisor", { env: SIDECAR_ENV }));
      throw new Error("expected buildResourceServiceSpec to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceEnvViolation);
      expect((err as ServiceEnvViolation).key).toBe("SIDECAR_FACILITATOR_TOKEN");
      expect((err as ServiceEnvViolation).message).not.toContain("abc.def");
    }
  });

  it("trusted and untrusted produce byte-identical isolation fields for an allowlisted-only input", () => {
    // Same allowlisted-only env so BOTH builders accept it; the ONLY admitted
    // difference is env keys, which are identical here.
    const trusted = buildTrustedServiceSpec(baseOpts("gvisor", { extraNetworks: ["controlplane"] }));
    const untrusted = buildResourceServiceSpec(
      baseOpts("gvisor", { extraNetworks: ["controlplane"] }),
    );

    // Every isolation/deployment field is identical.
    expect(trusted.runtime).toBe(untrusted.runtime);
    expect(trusted.readonlyRootfs).toBe(untrusted.readonlyRootfs);
    expect(trusted.tmpfs).toEqual(untrusted.tmpfs);
    expect(trusted.capDrop).toEqual(untrusted.capDrop);
    expect(trusted.capAdd).toEqual(untrusted.capAdd);
    expect(trusted.securityOpt).toEqual(untrusted.securityOpt);
    expect(trusted.pidsLimit).toBe(untrusted.pidsLimit);
    expect(trusted.memoryBytes).toBe(untrusted.memoryBytes);
    expect(trusted.cpus).toBe(untrusted.cpus);
    expect(trusted.storageOptSize).toBe(untrusted.storageOptSize);
    expect(trusted.restartPolicy).toEqual(untrusted.restartPolicy);
    expect(trusted.name).toBe(untrusted.name);
    expect(trusted.port).toBe(untrusted.port);
    expect(trusted.network).toBe(untrusted.network);
    expect(trusted.extraNetworks).toEqual(untrusted.extraNetworks);
    // The two specs are byte-identical when fed the same allowlisted-only env.
    expect(JSON.stringify(trusted)).toBe(JSON.stringify(untrusted));
  });

  it("still enforces ALL non-env validations (the trusted path relaxes ONLY the env guard)", () => {
    // network host/none
    expect(() => buildTrustedServiceSpec(baseOpts("gvisor", { network: "host" }))).toThrow(/host/);
    expect(() => buildTrustedServiceSpec(baseOpts("gvisor", { network: "none" }))).toThrow(/none/);
    expect(() => buildTrustedServiceSpec(baseOpts("gvisor", { network: "" }))).toThrow(/network/);
    // bad name
    expect(() => buildTrustedServiceSpec(baseOpts("gvisor", { name: "BAD-name" }))).toThrow(/name/);
    // non-positive limits/port
    expect(() => buildTrustedServiceSpec(baseOpts("gvisor", { port: 0 }))).toThrow(/port/);
    expect(() =>
      buildTrustedServiceSpec(baseOpts("gvisor", { limits: { ...LIMITS, memoryBytes: 0 } })),
    ).toThrow(/memoryBytes/);
    expect(() => buildTrustedServiceSpec(baseOpts("gvisor", { image: "" }))).toThrow(/image/);
    // host/none extraNetworks + duplicate primary
    expect(() => buildTrustedServiceSpec(baseOpts("gvisor", { extraNetworks: ["host"] }))).toThrow(
      /host/,
    );
    expect(() => buildTrustedServiceSpec(baseOpts("gvisor", { extraNetworks: ["none"] }))).toThrow(
      /none/,
    );
    expect(() =>
      buildTrustedServiceSpec(
        baseOpts("gvisor", { network: "ingress", extraNetworks: ["ingress"] }),
      ),
    ).toThrow(/duplicate/);
  });

  it("keeps the gVisor runsc boundary (runtime is never dropped on the trusted path)", () => {
    expect(buildTrustedServiceSpec(baseOpts("gvisor")).runtime).toBe("runsc");
    // And no auto-kill field on the trusted path either.
    const svc = buildTrustedServiceSpec(baseOpts("gvisor")) as unknown as Record<string, unknown>;
    expect("timeoutSeconds" in svc).toBe(false);
  });
});

describe("service-runspec - optional non-secret labels (reconcile-loop identity)", () => {
  const LABELS = { "io.utter.resource-id": "0x" + "ab".repeat(32), "io.utter.slug": "echo" };

  it("passes labels through to the spec when provided", () => {
    const svc = buildResourceServiceSpec(baseOpts("gvisor", { labels: LABELS }));
    expect(svc.labels).toEqual(LABELS);
  });

  it("carries labels into the dockerode create-options as Labels", () => {
    const svc = buildResourceServiceSpec(baseOpts("gvisor", { labels: LABELS }));
    expect(toServiceDockerodeCreateOptions(svc).Labels).toEqual(LABELS);
  });

  it("omitting labels leaves the spec isolation-identical (no behavior change)", () => {
    const withLabels = buildResourceServiceSpec(baseOpts("gvisor", { labels: LABELS }));
    const without = buildResourceServiceSpec(baseOpts("gvisor"));
    // No labels field at all when absent (additive, not a default).
    expect("labels" in without).toBe(false);
    expect(without.labels).toBeUndefined();
    // Every isolation-relevant field is identical with or without labels.
    expect(without.runtime).toBe(withLabels.runtime);
    expect(without.readonlyRootfs).toBe(withLabels.readonlyRootfs);
    expect(without.capDrop).toEqual(withLabels.capDrop);
    expect(without.capAdd).toEqual(withLabels.capAdd);
    expect(without.securityOpt).toEqual(withLabels.securityOpt);
    expect(without.tmpfs).toEqual(withLabels.tmpfs);
    expect(without.pidsLimit).toBe(withLabels.pidsLimit);
    expect(without.memoryBytes).toBe(withLabels.memoryBytes);
    expect(without.cpus).toBe(withLabels.cpus);
    expect(without.network).toBe(withLabels.network);
    // The dockerode create-options omit Labels entirely when absent.
    expect(toServiceDockerodeCreateOptions(without).Labels).toBeUndefined();
  });
});
