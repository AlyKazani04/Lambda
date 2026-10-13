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

// Precomputed once: waste at 10k req/s
const CUMULATIVE: ReadonlyArray<number> = (() => {
  const out: number[] = [];
  let sum = 0;

  for (const s of SCENARIOS) {
    sum += s.weight;
    out.push(sum);
  }

  return out;
})();

export const TOTAL_WEIGHT = CUMULATIVE[CUMULATIVE.length - 1] ?? 0;

// Pick a scenario by weighted random selection
export function pick(rng: () => number): Scenario {
  const r = rng() * TOTAL_WEIGHT;
  for (let i = 0; i < SCENARIOS.length; i += 1) {
    if ((CUMULATIVE[i] ?? 0) > r) {
      return SCENARIOS[i] as Scenario;
    }
  }

  return SCENARIOS[SCENARIOS.length - 1] as Scenario;
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
