// Round-robin upstream selection and instance discovery (F2 / A1).

import { lookup } from 'node:dns/promises';

import type { ProxyConfig, UpstreamTarget } from './config.js';

export interface UpstreamInstance {
  group: string;
  host: string;
  port: number;
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

export function instanceKey(instances: readonly UpstreamInstance[]): string {
  return instances
    .map((instance) => instance.id)
    .sort()
    .join(',');
}

export class RoundRobinPool {
  readonly group: string;
  #instances: readonly UpstreamInstance[];

  #cursor = 0;
  readonly #selections = new Map<string, number>();

  constructor(group: string, instances: readonly UpstreamInstance[]) {
    this.group = group;
    this.#instances = instances;
  }

  get instances(): readonly UpstreamInstance[] {
    return this.#instances;
  }

  get size(): number {
    return this.#instances.length;
  }

  get empty(): boolean {
    return this.#instances.length === 0;
  }

  /** Next instance in rotation. Throws when the pool is empty. */
  next(): UpstreamInstance {
    if (this.#instances.length === 0) {
      throw new Error(`upstream group "${this.group}" has no instances`);
    }
    const index = this.#cursor % this.#instances.length;
    // Modulo bounds the index by construction; noUncheckedIndexedAccess needs the assertion.
    const instance = this.#instances[index];
    if (instance === undefined) {
      throw new Error(`round-robin index ${index} out of range for group "${this.group}"`);
    }
    this.#selections.set(instance.id, (this.#selections.get(instance.id) ?? 0) + 1);
    this.#cursor += 1;
    return instance;
  }

  replaceInstances(instances: readonly UpstreamInstance[]): void {
    if (instances.length === 0) return; // never shrink to nothing on a blip
    this.#instances = instances;
  }

  stats(): Array<{ id: string; selections: number }> {
    return this.#instances.map((instance) => ({
      id: instance.id,
      selections: this.#selections.get(instance.id) ?? 0,
    }));
  }
}

async function resolveInstances(
  host: string,
  port: number,
  limit: number,
): Promise<UpstreamTarget[]> {
  const addresses = await lookup(host, { all: true });
  const unique = [...new Set(addresses.map((entry) => entry.address))];
  return unique.slice(0, limit).map((address) => ({ host: address, port }));
}

/**
 * One pool per upstream group named in the routing table.
 *
 * DNS resolution failure does not throw — the pool starts empty and the
 * discovery timer populates it once DNS resolves. This prevents the process
 * from exiting at startup when UPSTREAM_HOST is not yet resolvable (compose
 * start-order race, #35).
 */
export async function createPools(
  config: ProxyConfig,
): Promise<Map<string, RoundRobinPool>> {
  const pools = new Map<string, RoundRobinPool>();

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
        try {
          cached = await resolveInstances(
            config.upstreamHost,
            config.upstreamPort,
            config.instanceCount,
          );
        } catch {
          cached = [];
        }
        resolved.set(resolveKey, cached);
      }
      targets = cached;
    }

    pools.set(group, new RoundRobinPool(group, targets.map((t) => instanceFor(group, t))));
  }

  return pools;
}

export interface DiscoveryHandle {
  refresh: () => Promise<void>;
  stop: () => void;
}

// Re-resolve DNS on an interval so runtime --scale takes effect and a
// start-order race (one replica registered, not all N) self-corrects.
// Groups with explicit UPSTREAM_TARGETS are pinned and left alone.
export function startDiscovery(
  config: ProxyConfig,
  pools: Map<string, RoundRobinPool>,
  onChanged?: (group: string, instances: readonly UpstreamInstance[]) => void,
): DiscoveryHandle {
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
  timer.unref();

  return {
    refresh,
    stop: () => clearInterval(timer),
  };
}
