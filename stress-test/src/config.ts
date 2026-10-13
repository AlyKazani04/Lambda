import { availableParallelism } from 'node:os';
import { applyWeights, buildTable, type WeightedTable } from './scenarios.js';

export interface RunConfig {
  target: string;
  durationMs: number;
  concurrency: number;
  rampMs: number;
  workers: number;
  seed: number;
  collector: string | null;
  label: string;
  table: WeightedTable;
}

export const DEFAULTS = {
  target: 'http://127.0.0.1:3001',
  durationMs: 10_000,
  concurrency: 50,
  rampMs: 2_000,
  seed: 12345,
  workers: 0,
};

export class UsageError extends Error { }

function readFlag(argv: string[], name: string): string | undefined {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);

  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function intFlag(
  argv: string[],
  name: string,
  fallback: number,
  { allowZero = false }: { allowZero?: boolean } = {},
): number {
  const raw = readFlag(argv, name);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new UsageError(
      `--${name} must be an integer ${allowZero ? '>= 0' : '>= 1'}, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

// --weights like:20,follow:5 named overrides, validated against the table
function parseWeights(argv: string[]): Record<string, number> {
  const raw = readFlag(argv, 'weights');
  if (raw === undefined || raw.trim() === '') return {};

  const overrides: Record<string, number> = {};
  for (const pair of raw.split(',')) {
    const [name, value] = pair.split(':');
    if (name === undefined || value === undefined || name.trim() === '') {
      throw new UsageError(`--weights expects name:value pairs, got ${JSON.stringify(pair)}`);
    }
    const weight = Number(value);
    if (!Number.isFinite(weight) || weight < 0) {
      throw new UsageError(`weight for "${name}" must be >= 0, got ${JSON.stringify(value)}`);
    }
    overrides[name.trim()] = weight;
  }
  return overrides;
}

export function parseArgs(argv: string[]): RunConfig {
  const target = readFlag(argv, 'target') ?? DEFAULTS.target;
  const durationMs = intFlag(argv, 'duration', DEFAULTS.durationMs);
  const concurrency = intFlag(argv, 'concurrency', DEFAULTS.concurrency);
  // --ramp 0 means start at that level of concurrency
  const rampMs = intFlag(argv, 'ramp', DEFAULTS.rampMs, { allowZero: true });
  const workers =
    intFlag(argv, 'workers', 0, { allowZero: true }) || availableParallelism();
  const seed = intFlag(argv, 'seed', DEFAULTS.seed, { allowZero: true });
  const collector = readFlag(argv, 'collector') ?? null;
  const label = readFlag(argv, 'label') ?? 'run';

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new UsageError(`--target must be a URL, got ${JSON.stringify(target)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError(`--target must be http(s), got ${parsed.protocol}`);
  }

  const table = buildTable(applyWeights(parseWeights(argv)));

  return {
    target: target.replace(/\/+$/, ''),
    durationMs,
    concurrency,
    rampMs,
    workers,
    seed,
    collector,
    label,
    table,
  };
}

export const HELP = `
stress-test — multi-threaded HTTP load generator

  --target <url>        base URL to load (default ${DEFAULTS.target})
  --duration <ms>       run length (default ${DEFAULTS.durationMs})
  --concurrency <n>     target in-flight requests (default ${DEFAULTS.concurrency})
  --ramp <ms>           ramp-up window, 0 = no ramp (default ${DEFAULTS.rampMs})
  --workers <n>         worker threads, 0 = CPU cores (default 0)
  --seed <n>            RNG seed, recorded in the report (default ${DEFAULTS.seed})
  --weights <list>      scenario overrides, e.g. like:20,follow:5
  --collector <url>     POST aggregates here when the run ends
  --label <name>        run label carried in the report (default "run")
  --help                this text
`.trim();
