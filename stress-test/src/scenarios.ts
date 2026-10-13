export type Behaviour =
  | 'ok'
  | 'status'
  | 'small'
  | 'large'
  | 'slow'
  | 'reset'
  | 'close'
  | 'chunked';

export type Scenario = {
  readonly name: string;
  readonly weight: number;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly behaviour?: Behaviour;
  readonly params?: Record<string, string>;
  readonly expectError: boolean;
};

// Mulberry32 seeded random number generator
export function rand(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    name: 'read_timeline',
    weight: 40,
    method: 'GET',
    path: '/timeline/home',
    expectError: false,
  },
  {
    name: 'post_tweet',
    weight: 25,
    method: 'POST',
    path: '/api/small',
    behaviour: 'chunked',
    params: { n: '8' },
    expectError: false,
  },
  {
    name: 'like',
    weight: 15,
    method: 'POST',
    path: '/api/small',
    expectError: false,
  },
  {
    name: 'follow',
    weight: 10,
    method: 'POST',
    path: '/api/slow',
    behaviour: 'slow',
    params: { ms: '250' },
    expectError: false,
  },
  {
    name: 'view_profile',
    weight: 10,
    method: 'GET',
    path: '/api/status',
    behaviour: 'status',
    expectError: false,
  },
];

export interface WeightedTable {
  readonly scenarios: ReadonlyArray<Scenario>;
  readonly cumulative: ReadonlyArray<number>;
  readonly total: number;
}

// Precompute cumulative weights once
export function buildTable(scenarios: ReadonlyArray<Scenario>): WeightedTable {
  const cumulative: number[] = [];
  let sum = 0;

  for (const s of scenarios) {
    sum += s.weight;
    cumulative.push(sum);
  }

  return {
    scenarios,
    cumulative,
    total: cumulative[cumulative.length - 1] ?? 0,
  };
}

export const DEFAULT_TABLE = buildTable(SCENARIOS);

export const TOTAL_WEIGHT = DEFAULT_TABLE.total;

export function pickFrom(rng: () => number, table: WeightedTable): Scenario {
  const r = rng() * table.total;
  for (let i = 0; i < table.scenarios.length; i += 1) {
    if ((table.cumulative[i] ?? 0) > r) {
      return table.scenarios[i] as Scenario;
    }
  }

  return table.scenarios[table.scenarios.length - 1] as Scenario;
}

export function pick(rng: () => number): Scenario {
  return pickFrom(rng, DEFAULT_TABLE);
}

// Query string or '' when none needed
export function queryFor(scenario: Scenario): string {
  const params = new URLSearchParams();

  if (scenario.behaviour !== undefined) {
    params.set('behaviour', scenario.behaviour);
  }

  for (const [key, value] of Object.entries(scenario.params ?? {})) {
    params.set(key, value);
  }

  const qs = params.toString();
  return qs === '' ? '' : `?${qs}`;
}

export function urlFor(target: string, scenario: Scenario): string {
  return `${target}${scenario.path}${queryFor(scenario)}`;
}

// Fixed size so bytesOut is non-zero and identical across runs
const POST_BODY = JSON.stringify({ pad: 'x'.repeat(480) });

export function bodyFor(scenario: Scenario): string | undefined {
  return scenario.method === 'POST' ? POST_BODY : undefined;
}

export function applyWeights(
  overrides: Record<string, number>,
): ReadonlyArray<Scenario> {
  return SCENARIOS.map((s) => {
    const override = overrides[s.name];
    return override === undefined ? s : { ...s, weight: override };
  });
}
