// Round-robin upstream selection and instance discovery (F2 / A1).
//
// A pool holds an ordered list of instances and a pointer. Each request takes
// the next instance, wrapping at the end. No measurement, no health awareness
// — pure rotation. That is deliberate for v1: it is the simplest strategy that
// is actually fair, and it forces the proxy to know *which* instance served a
// request, which is the hook a circuit breaker (A7, cut) would hang off.

import { lookup } from 'node:dns/promises';

import type { ProxyConfig, UpstreamTarget } from './config.js';

export interface UpstreamInstance {
  /** Upstream group this instance belongs to. */
  group: string;
  host: string;
  port: number;
  /** Stable label for the per-request log line: `host:port`. */
  id: string;
}

function instanceFor(group: string, target: UpstreamTarget): UpstreamInstance {
  return {
    group,
    host: target.host,
    port: target.port,
    id: `${target.host}:${target.port}`,
  };
}

/** Stable, order-independent key for an instance set. */
export function instanceKey(instances: readonly UpstreamInstance[]): string {
  return instances
    .map((instance) => instance.id)
    .sort()
    .join(',');
}

/**
 * Ordered instance list plus a rotation pointer.
 *
 * One pool per upstream group, so /api and /timeline rotate independently —
 * two groups sharing a pointer would mean a busy path advances a quiet path's
 * rotation, which is not what "per-group round robin" means.
 */
export class RoundRobinPool {
  readonly group: string;
  #instances: readonly UpstreamInstance[];

  #cursor = 0;
  /** Selections per instance id. A Map rather than a parallel array so the
   * counts survive the instance list being replaced by re-discovery. */
  readonly #selections = new Map<string, number>();

  constructor(group: string, instances: readonly UpstreamInstance[]) {
    if (instances.length === 0) {
      throw new Error(`upstream group "${group}" has no instances`);
    }
    this.group = group;
    this.#instances = instances;
  }

  get instances(): readonly UpstreamInstance[] {
    return this.#instances;
  }

  get size(): number {
    return this.#instances.length;
  }

  /** Next instance in rotation. */
  next(): UpstreamInstance {
    const index = this.#cursor % this.#instances.length;
    // Bounded by construction (modulo of a non-negative integer into a
    // non-empty array); noUncheckedIndexedAccess still needs the assertion.
    const instance = this.#instances[index];
    if (instance === undefined) {
      throw new Error(`round-robin index ${index} out of range for group "${this.group}"`);
    }
    this.#selections.set(instance.id, (this.#selections.get(instance.id) ?? 0) + 1);
    this.#cursor += 1;
    return instance;
  }

  /**
   * Swap in a new instance list. The cursor is kept, so rotation continues
   * from where it was rather than restarting at the first instance — a
   * restart would bias the new list's head, and the whole point of the
   * rotation is that it is not biased.
   */
  replaceInstances(instances: readonly UpstreamInstance[]): void {
    if (instances.length === 0) return; // never shrink to nothing on a blip
    this.#instances = instances;
  }

  /** Selections per instance since start. Corroborates the log line. */
  stats(): Array<{ id: string; selections: number }> {
    return this.#instances.map((instance) => ({
      id: instance.id,
      selections: this.#selections.get(instance.id) ?? 0,
    }));
  }
}

/**
 * Resolve a hostname to up to `limit` addresses.
 *
 * This is what makes the instance count come from the deployment rather than
 * from source: `docker compose up --scale stub=3` gives the service name three
 * A records on the compose network, and those three addresses *are* the
 * instance list. An IP literal resolves to itself, so a single-upstream local
 * run works through the same path.
 */
async function resolveInstances(
  host: string,
  port: number,
  limit: number,
): Promise<UpstreamTarget[]> {
  const addresses = await lookup(host, { all: true });
  const unique = [...new Set(addresses.map((entry) => entry.address))];
  return unique.slice(0, limit).map((address) => ({ host: address, port }));
}

/** One pool per upstream group named in the routing table. */
export async function createPools(
  config: ProxyConfig,
): Promise<Map<string, RoundRobinPool>> {
  const pools = new Map<string, RoundRobinPool>();

  // Resolve each distinct host once and share the address list across groups
  // that use it — the groups differ by cursor, not by address set.
  const resolved = new Map<string, readonly UpstreamTarget[]>();
  const resolveKey = `${config.upstreamHost}:${config.upstreamPort}`;

  for (const group of new Set(config.routes.map((route) => route.group))) {
    const explicit = config.explicitTargets.get(group) ?? [];

    let targets: readonly UpstreamTarget[];
    if (explicit.length > 0) {
      targets = explicit;
    } else {
      let cached = resolved.get(resolveKey);
      if (cached === undefined) {
        cached = await resolveInstances(
          config.upstreamHost,
          config.upstreamPort,
          config.instanceCount,
        );
        resolved.set(resolveKey, cached);
      }
      targets = cached;
    }

    if (targets.length === 0) {
      throw new Error(
        `upstream group "${group}" resolved to zero instances; ` +
          `set UPSTREAM_TARGETS or check UPSTREAM_HOST="${config.upstreamHost}"`,
      );
    }

    pools.set(group, new RoundRobinPool(group, targets.map((t) => instanceFor(group, t))));
  }

  return pools;
}

export interface DiscoveryHandle {
  /** Resolve once now, outside the timer, so the caller can await the result. */
  refresh: () => Promise<void>;
  stop: () => void;
}

/**
 * Keep each pool's instance list in step with what DNS says.
 *
 * WHY THIS EXISTS — the failure it prevents is silent and permanent:
 * `depends_on: service_healthy` waits for *one* replica of a service, not all
 * N. Under `docker compose up --scale stub=3`, the proxy can therefore resolve
 * the `stub` name while only one replica has registered, cache a one-address
 * list, and rotate over a single instance forever. Nothing errors; the
 * round-robin simply never advances, which looks exactly like a broken pointer.
 * Re-resolving on an interval turns that into a self-healing condition.
 *
 * It also makes runtime scaling work: `--scale stub=5` after startup is picked
 * up on the next tick rather than needing a proxy restart.
 *
 * Explicitly configured groups (UPSTREAM_TARGETS) are left alone — the operator
 * named those instances, so DNS is not the authority for them.
 */
export function startDiscovery(
  config: ProxyConfig,
  pools: Map<string, RoundRobinPool>,
  onChanged?: (group: string, instances: readonly UpstreamInstance[]) => void,
): DiscoveryHandle {
  // Groups whose membership came from configuration rather than DNS.
  const pinned = new Set(
    [...config.explicitTargets.entries()]
      .filter(([, targets]) => targets.length > 0)
      .map(([group]) => group),
  );

  const refresh = async (): Promise<void> => {
    let targets: readonly UpstreamTarget[];
    try {
      targets = await resolveInstances(
        config.upstreamHost,
        config.upstreamPort,
        config.instanceCount,
      );
    } catch (error) {
      // A transient resolver failure must not take the proxy down or wipe the
      // working instance list; the next tick retries.
      console.warn(
        `upstream discovery failed for "${config.upstreamHost}": ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (targets.length === 0) return;

    for (const [group, pool] of pools) {
      if (pinned.has(group)) continue;
      const next = targets.map((t) => instanceFor(group, t));
      if (instanceKey(next) === instanceKey(pool.instances)) continue;

      const previous = pool.instances.map((i) => i.id).join(', ');
      pool.replaceInstances(next);
      // Logged loudly: this is the line that explains a rotation which changed
      // mid-run, and the evidence that a start-order race self-corrected.
      console.log(
        `upstream discovery: group=${group} instances [${previous}] -> ` +
          `[${next.map((i) => i.id).join(', ')}]`,
      );
      onChanged?.(group, next);
    }
  };

  if (config.discoveryIntervalMs <= 0) {
    return { refresh: async () => {}, stop: () => {} };
  }

  const timer = setInterval(() => {
    void refresh();
  }, config.discoveryIntervalMs);
  // Do not hold the event loop open on this timer alone.
  timer.unref();

  return {
    refresh,
    stop: () => clearInterval(timer),
  };
}
