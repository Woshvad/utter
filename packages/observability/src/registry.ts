// registry.ts - the OBS-01 dependency-free in-process metric registry.
//
// Mirrors the plain-counter discipline of packages/data-proxy/src/quota.ts:
// counters are NUMBERS, never USDC amounts, and carry NO decimals literal.
// Only the dedicated UsdcGauge carries base-unit money, and even it never embeds a
// decimals literal: the decimals come from a runtime read passed in at RENDER time
// (Pitfall 3 / T-06-DECIMALS), exactly as packages/chain/src/usdc.ts reads
// decimals() from the contract rather than hardcoding a fixed value.
//
// There is intentionally NO numeric decimals literal anywhere below. The USDC
// formatting uses viem `formatUnits(baseUnits, decimals)` with the decimals value
// the caller supplies from `@utter/chain` readUsdcBalance / a runtime decimals()
// read. The live chain-balance reads (escrow/relayer) are operator-gated; this
// registry only holds the gauge and renders whatever base units it is fed (real
// counters in the live path, deterministic fixtures in tests - never faked values,
// Pitfall 8).
import { formatUnits } from "viem";

/** A monotonic counter. inc(n) accumulates (default 1); plain number, never money. */
export class Counter {
  private v = 0;
  inc(n = 1): void {
    this.v += n;
  }
  get value(): number {
    return this.v;
  }
}

/** A gauge: set(n) replaces the current value. Plain number, never USDC base units. */
export class Gauge {
  private v = 0;
  set(n: number): void {
    this.v = n;
  }
  get value(): number {
    return this.v;
  }
}

/** A single histogram bucket: the running count of observations <= `le` (ms). */
export interface HistogramBucket {
  /** The upper bound (inclusive) for this bucket, in milliseconds. */
  le: number;
  /** Number of observations whose value is <= `le`. */
  count: number;
}

/** Default settle-latency bucket bounds (ms). Advisory; callers may override. */
const DEFAULT_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000] as const;

/**
 * A histogram for settle-latency (ms). observe(ms) records into count/sum and the
 * cumulative-style per-bucket counts. count/sum drive `settle_latency_count` /
 * `settle_latency_sum`; the buckets expose the latency distribution.
 */
export class Histogram {
  private _count = 0;
  private _sum = 0;
  private readonly _buckets: HistogramBucket[];

  constructor(bounds: readonly number[] = DEFAULT_BUCKETS) {
    this._buckets = bounds.map((le) => ({ le, count: 0 }));
  }

  observe(ms: number): void {
    this._count += 1;
    this._sum += ms;
    for (const bucket of this._buckets) {
      if (ms <= bucket.le) bucket.count += 1;
    }
  }

  get count(): number {
    return this._count;
  }
  get sum(): number {
    return this._sum;
  }
  get buckets(): HistogramBucket[] {
    return this._buckets.map((b) => ({ ...b }));
  }
}

/**
 * A USDC gauge. It stores the amount in BASE UNITS (bigint - the 6-dp ERC-20 raw
 * value) and formats it 6dp-aware ONLY at render time, from the decimals value the
 * caller passes in (a runtime decimals() read via @utter/chain). There is NO
 * decimals literal in the math path: format delegates to viem `formatUnits`, which
 * applies the supplied decimals. This is the T-06-DECIMALS enforcement point.
 */
export class UsdcGauge {
  private v = 0n;
  set(baseUnits: bigint): void {
    this.v = baseUnits;
  }
  get baseUnits(): bigint {
    return this.v;
  }
  /** Format the stored base units using the RUNTIME decimals passed by the caller. */
  format(decimals: number): string {
    return formatUnits(this.v, decimals);
  }
}

/** Anything renderable as a single `name value` Prometheus line. */
export interface Renderable {
  value: number;
}

/**
 * Render a flat `name -> { value }` map as Prometheus exposition text: one
 * `name value` line per metric, terminated by a trailing newline (RESEARCH
 * Pattern 5). USDC gauges are pre-formatted to their numeric value by the Registry
 * before they reach here, so this helper carries no money knowledge.
 */
export function renderPrometheus(metrics: Record<string, Renderable>): string {
  return (
    Object.entries(metrics)
      .map(([name, m]) => `${name} ${m.value}`)
      .join("\n") + "\n"
  );
}

/** The full OBS-01 named metric set rendered by Registry.render(). */
export const OBS_METRIC_NAMES = [
  "calls_total",
  "calls_per_min",
  "settle_latency",
  "settle_failures_total",
  "reservations_open",
  "reservations_released",
  "escrow_usdc",
  "relayer_usdc",
  "health_score",
  "gross_usdc",
  "creator_usdc",
  "platform_usdc",
  "refund_usdc",
  "sandbox_denials_total",
  // SCL-06 cost attribution: per-call cost and per-resource cost, both 6dp USDC
  // base units surfaced through the same runtime-decimals discipline as the other
  // USDC gauges. Native-18dp relayer gas is NOT surfaced here as a USDC gauge - it
  // lives in the CostAttributor's separate gas lane (Pitfall 5).
  "cost_call_usdc",
  "cost_resource_usdc",
] as const;

/**
 * The OBS-01 registry: the named metric set covering the whole money path. Counters
 * and plain gauges hold numbers; the USDC gauges (escrow/relayer/gross/creator/
 * platform/refund) hold base units and render 6dp-aware from a runtime decimals.
 *
 * The live path injects this registry into the facilitator/deployer/scorer so they
 * tap REAL counters (no faking, Pitfall 8); the fixture path seeds it with
 * deterministic values. Live chain-balance reads for escrow/relayer USDC are
 * operator-gated - the gauge is exposed here, the on-chain read is deferred.
 */
export class Registry {
  // Plain counters/gauges/histogram - numbers, never money.
  readonly callsTotal = new Counter();
  readonly callsPerMin = new Gauge();
  readonly settleLatency = new Histogram();
  readonly settleFailuresTotal = new Counter();
  readonly reservationsOpen = new Gauge();
  readonly reservationsReleased = new Counter();
  readonly healthScore = new Gauge();
  readonly sandboxDenialsTotal = new Counter();

  // USDC gauges - base units, formatted 6dp-aware from a runtime decimals at render.
  readonly escrowUsdc = new UsdcGauge();
  readonly relayerUsdc = new UsdcGauge();
  readonly grossUsdc = new UsdcGauge();
  readonly creatorUsdc = new UsdcGauge();
  readonly platformUsdc = new UsdcGauge();
  readonly refundUsdc = new UsdcGauge();

  // SCL-06 cost gauges - 6dp USDC base units (per-call cost, per-resource cost).
  // Fed by @utter/cost CostAttributor. Native-18dp gas is kept out of these
  // gauges - it never mixes with 6dp USDC (Pitfall 5).
  readonly costCallUsdc = new UsdcGauge();
  readonly costResourceUsdc = new UsdcGauge();

  /**
   * Render the OBS-01 metric set as Prometheus text. `decimals` is the runtime
   * USDC decimals read (e.g. via @utter/chain readUsdcBalance) - it is applied to
   * every USDC gauge here, never hardcoded. The plain metrics render their numeric
   * value; the USDC gauges render their decimals-formatted value as a number.
   */
  render(decimals: number): string {
    const metrics: Record<string, Renderable> = {
      calls_total: { value: this.callsTotal.value },
      calls_per_min: { value: this.callsPerMin.value },
      settle_latency: { value: this.settleLatency.sum },
      settle_failures_total: { value: this.settleFailuresTotal.value },
      reservations_open: { value: this.reservationsOpen.value },
      reservations_released: { value: this.reservationsReleased.value },
      escrow_usdc: { value: Number(this.escrowUsdc.format(decimals)) },
      relayer_usdc: { value: Number(this.relayerUsdc.format(decimals)) },
      health_score: { value: this.healthScore.value },
      gross_usdc: { value: Number(this.grossUsdc.format(decimals)) },
      creator_usdc: { value: Number(this.creatorUsdc.format(decimals)) },
      platform_usdc: { value: Number(this.platformUsdc.format(decimals)) },
      refund_usdc: { value: Number(this.refundUsdc.format(decimals)) },
      sandbox_denials_total: { value: this.sandboxDenialsTotal.value },
      cost_call_usdc: { value: Number(this.costCallUsdc.format(decimals)) },
      cost_resource_usdc: {
        value: Number(this.costResourceUsdc.format(decimals)),
      },
    };
    return renderPrometheus(metrics);
  }
}
