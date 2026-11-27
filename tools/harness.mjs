#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

const NETEM_PROFILES = new Set(['wan', 'mild', 'fast', 'lossy', 'off']);

export const HELP = `
Lambda stack harness

  ./up.sh [flags]     bring the full stack up, wait for health, apply netem
  ./down.sh [flags]   remove netem, then tear the stack down

Flags
  --remote                 bind proxy and dashboard to the Tailscale IP
  --lan                    publish proxy and dashboard on 0.0.0.0 for a LAN run
  --lan-ip <ip>            LAN IP to print; detected with hostname -I by default
  --tailscale-ip <ip>      use this IP instead of detecting it
  --netem <profile|off>    wan|mild|fast|lossy|off (default: $NETEM_PROFILE or wan)
  --iface <name>           physical NIC for capture and netem (default: $CAPTURE_IFACE)
  --no-capture-check       skip the NIC traffic sanity check
  --help                   show this text

Environment
  SUDO=1                   prefix docker/tc commands with sudo
  LAMBDA_REMOTE=1          same as --remote
  TAILSCALE_IP, NETEM_PROFILE, CAPTURE_IFACE

netem is egress-only: the wan profile adds ~20 ms to one leg, so expect an RTT
around 20 ms rather than 40 ms. The harness asserts the root qdisc contains
netem after up, and contains no netem qdisc after down.
`.trim();

export class UsageError extends Error { }

export class HarnessError extends Error {
  constructor(step, detail) {
    super(`${step}: ${detail}`);
    this.step = step;
    this.detail = detail;
  }
}

export function parseArgs(argv, env = process.env) {
  const [command, ...rest] = argv;
  const flag = (name) => {
    const index = rest.indexOf(`--${name}`);
    if (index === -1) return undefined;
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`--${name} needs a value`);
    }
    return value;
  };
  const has = (name) => rest.includes(`--${name}`);

  if (command === '--help' || command === '-h' || has('help')) {
    return { help: true };
  }
  if (command !== 'up' && command !== 'down') {
    throw new UsageError(`expected 'up' or 'down', got ${JSON.stringify(command ?? '')}`);
  }

  const netemProfile = flag('netem') ?? env.NETEM_PROFILE ?? 'wan';
  if (!NETEM_PROFILES.has(netemProfile)) {
    throw new UsageError(`--netem must be one of ${[...NETEM_PROFILES].join(', ')}`);
  }

  const remote = has('remote') || env.LAMBDA_REMOTE === '1';
  const lan = has('lan') || env.LAMBDA_LAN === '1';
  if (remote && lan) {
    throw new UsageError('--remote and --lan are mutually exclusive');
  }

  return {
    help: false,
    command,
    remote,
    lan,
    lanIp: flag('lan-ip') ?? env.LAN_IP ?? null,
    tailscaleIp: flag('tailscale-ip') ?? env.TAILSCALE_IP ?? null,
    netemProfile,
    iface: flag('iface') ?? env.CAPTURE_IFACE ?? 'wlp0s20f3',
    skipCaptureCheck: has('no-capture-check'),
    sudo: env.SUDO === '1',
  };
}

export function formatCommand(command, args) {
  return [command, ...args]
    .map((part) => (/[\s"']/u.test(part) ? JSON.stringify(part) : part))
    .join(' ');
}

export function withSudo(command, args, sudo) {
  return sudo ? ['sudo', [command, ...args]] : [command, args];
}

export function composeCommand(options) {
  const args = ['compose', '-f', 'docker-compose.yml'];
  if (options.remote) args.push('-f', 'compose.tailscale.yml');
  if (options.lan) args.push('-f', 'compose.lan-harness.yml');
  return ['docker', args];
}

function composeEnv(options) {
  if (options.remote && options.tailscaleIp !== null) {
    return { TAILSCALE_IP: options.tailscaleIp };
  }
  if (options.lan && options.lanIp !== null) {
    return { LAN_IP: options.lanIp };
  }
  return {};
}

export function parseListeners(output) {
  const listeners = [];
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/u);
    if (fields[0] !== 'LISTEN' || fields.length < 4) continue;
    const local = fields[3];
    const separator = local.lastIndexOf(':');
    if (separator === -1) continue;
    listeners.push({
      address: local.slice(0, separator),
      port: Number(local.slice(separator + 1)),
      raw: line.trim(),
    });
  }
  return listeners;
}

export function expectedBindings(options) {
  if (options.remote && options.tailscaleIp !== null) {
    return [
      { host: '127.0.0.1', port: 3001 },
      { host: '127.0.0.1', port: 3002 },
      { host: '127.0.0.1', port: 3003 },
      { host: options.tailscaleIp, port: 8080 },
      { host: options.tailscaleIp, port: 3000 },
    ];
  }
  if (options.lan) {
    return [
      { host: '0.0.0.0', port: 3000 },
      { host: '0.0.0.0', port: 8080 },
      { host: '127.0.0.1', port: 3001 },
      { host: '127.0.0.1', port: 3002 },
      { host: '127.0.0.1', port: 3003 },
    ];
  }
  return [
    { host: '127.0.0.1', port: 3000 },
    { host: '127.0.0.1', port: 3001 },
    { host: '127.0.0.1', port: 3002 },
    { host: '127.0.0.1', port: 3003 },
    { host: '127.0.0.1', port: 8080 },
  ];
}

export function serviceHost(options) {
  return options.remote && options.tailscaleIp !== null
    ? options.tailscaleIp
    : '127.0.0.1';
}

export function displayHost(options) {
  if (options.remote && options.tailscaleIp !== null) return options.tailscaleIp;
  if (options.lan && options.lanIp !== null) return options.lanIp;
  return '127.0.0.1';
}

export function findPortConflicts(listeners, bindings) {
  const wildcard = new Set(['0.0.0.0', '*', '[::]', '::']);
  const conflicts = [];
  for (const binding of bindings) {
    for (const listener of listeners) {
      if (listener.port !== binding.port) continue;
      if (!wildcard.has(listener.address) && listener.address !== binding.host) continue;
      conflicts.push({ ...binding, listener: listener.raw });
    }
  }
  return conflicts;
}

export const defaultDeps = {
  env: process.env,
  existsSync,
  isRoot: () => typeof process.getuid === 'function' && process.getuid() === 0,
  exec(command, args, options = {}) {
    const result = spawnSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      ...options,
    });
    if (result.error !== undefined) {
      return { code: 127, stdout: '', stderr: result.error.message };
    }
    return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  },
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
};

function outputTail(result) {
  return [result.stderr, result.stdout]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join('\n')
    .trim()
    .split('\n')
    .slice(-8)
    .join('\n');
}

function run(deps, options, name, command, args, config = {}) {
  const [actualCommand, actualArgs] = withSudo(command, args, options.sudo);
  deps.log(`STEP ${name}: ${formatCommand(actualCommand, actualArgs)}`);
  const result = deps.exec(actualCommand, actualArgs, {
    env: { ...deps.env, ...config.env },
  });
  const detail = outputTail(result);
  if (result.code !== 0) {
    const message = `${name} exited ${result.code}${detail === '' ? '' : `\n${detail}`}`;
    if (config.allowFailure) {
      deps.log(`WARN ${message} (continuing)`);
      return { ok: false, ...result };
    }
    throw new HarnessError(name, `exited ${result.code}${detail === '' ? '' : `\n${detail}`}`);
  }
  deps.log(`OK ${name}`);
  return { ok: true, ...result };
}

export async function waitForHttp(url, config = {}) {
  const {
    fetchImpl = defaultDeps.fetch,
    sleep = defaultDeps.sleep,
    timeoutMs = 60_000,
    intervalMs = 1_000,
  } = config;
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  let lastError = '';
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(3_000) });
      lastStatus = response.status;
      if (response.ok) return { ok: true, attempts: attempt, lastStatus, lastError: '' };
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < maxAttempts) await sleep(intervalMs);
  }
  return { ok: false, attempts: maxAttempts, lastStatus, lastError };
}

function checkPorts(options, deps) {
  const listed = deps.exec('ss', ['-ltn']);
  if (listed.code !== 0) {
    deps.log('WARN port-check: ss is unavailable, skipping port preflight');
    return;
  }
  const conflicts = findPortConflicts(parseListeners(listed.stdout), expectedBindings(options));
  if (conflicts.length > 0) {
    const detail = conflicts
      .map((conflict) => `${conflict.host}:${conflict.port} <- ${conflict.listener}`)
      .join('\n');
    throw new HarnessError(
      'preflight',
      `ports already in use:\n${detail}\nStop the owner or run ./down.sh before starting again`,
    );
  }
  deps.log(`OK ports: ${expectedBindings(options).map((b) => `${b.host}:${b.port}`).join(', ')} are free`);
}

function preflight(options, deps) {
  if (!deps.existsSync(path.join(ROOT, '.env'))) {
    throw new HarnessError('preflight', '.env is missing — copy .env.example to .env first');
  }

  run(deps, options, 'docker-daemon', 'docker', ['info', '--format', '{{.ServerVersion}}']);
  const [command, args] = composeCommand(options);
  run(deps, options, 'compose-config', command, [...args, 'config', '--quiet'], {
    env: composeEnv(options),
  });

  if (options.remote && options.tailscaleIp === null) {
    const detected = deps.exec('tailscale', ['ip', '-4']);
    const ip = detected.stdout.trim().split('\n')[0]?.trim() ?? '';
    if (detected.code !== 0 || ip === '') {
      throw new HarnessError(
        'preflight',
        'Tailscale is stopped or has no IPv4 address; start it or pass --tailscale-ip',
      );
    }
    options.tailscaleIp = ip;
    deps.log(`OK tailscale-ip: ${ip}`);
  }

  if (options.lan && options.lanIp === null) {
    const detected = deps.exec('hostname', ['-I']);
    const ip = detected.stdout.trim().split(/\s+/u)
      .find((entry) => /^\d+\.\d+\.\d+\.\d+$/u.test(entry));
    if (detected.code !== 0 || ip === undefined) {
      throw new HarnessError('preflight', 'could not detect a LAN IPv4 address; pass --lan-ip');
    }
    options.lanIp = ip;
    deps.log(`OK lan-ip: ${ip}`);
  }

  checkPorts(options, deps);

  if (options.netemProfile !== 'off') {
    if (!deps.existsSync(`/sys/class/net/${options.iface}`)) {
      throw new HarnessError('preflight', `interface ${options.iface} does not exist`);
    }
    if (!deps.isRoot() && !options.sudo) {
      throw new HarnessError(
        'preflight',
        'netem needs CAP_NET_ADMIN — run with SUDO=1 or use --netem off',
      );
    }
  }

  if (!options.skipCaptureCheck) {
    const found = deps.exec('sh', ['-c', 'command -v tshark']);
    if (found.code !== 0) {
      throw new HarnessError('preflight', 'tshark is missing — install wireshark-cli');
    }
  }
}

async function verifyServices(options, deps) {
  const host = serviceHost(options);
  let body;
  try {
    const response = await deps.fetch(`http://${host}:3000/api/services`, {
      signal: AbortSignal.timeout(5_000),
    });
    body = await response.json();
  } catch (error) {
    throw new HarnessError(
      'services',
      `could not read dashboard service health: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const services = Array.isArray(body?.services) ? body.services : [];
  const down = services.filter((service) => service.status !== 'up');
  if (down.length > 0) {
    const detail = down
      .map((service) => `${service.name}: ${service.error ?? `status=${service.status}`}`)
      .join('\n');
    throw new HarnessError('services', `not ready:\n${detail}`);
  }
  deps.log(`OK services: ${services.map((service) => service.name).join(', ')}`);
}

export async function verifyCollector(options, deps = defaultDeps) {
  const base = `http://${serviceHost(options)}:3000`;
  let timeResponse;
  let timeBody;
  try {
    timeResponse = await deps.fetch(`${base}/api/time`, { signal: AbortSignal.timeout(5_000) });
    timeBody = await timeResponse.json();
  } catch (error) {
    throw new HarnessError(
      'collector',
      `/api/time did not return JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!timeResponse.ok || typeof timeBody?.now !== 'number') {
    throw new HarnessError(
      'collector',
      `/api/time returned status ${timeResponse.status} without a numeric "now" — the dashboard image may be stale`,
    );
  }

  let reportResponse;
  let reportBody;
  try {
    reportResponse = await deps.fetch(`${base}/api/aggregates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'progress', summary: { label: 'harness-probe' } }),
      signal: AbortSignal.timeout(5_000),
    });
    reportBody = await reportResponse.json();
  } catch (error) {
    throw new HarnessError(
      'collector',
      `/api/aggregates did not return JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!reportResponse.ok || reportBody?.ok !== true) {
    throw new HarnessError(
      'collector',
      `/api/aggregates returned status ${reportResponse.status} without {"ok":true} — the dashboard image may be stale`,
    );
  }
  deps.log('OK collector: /api/time and /api/aggregates respond with JSON');
}

function printSummary(options, deps) {
  const host = displayHost(options);
  deps.log('');
  deps.log('Stack up.');
  deps.log(`  dashboard: http://${host}:3000`);
  deps.log(`  proxy:     http://${host}:8080/health`);
  deps.log(`  collector: http://${host}:3000/api/time`);
  if (options.remote) {
    deps.log('  loopback 3000/8080 are not published in --remote mode; stub stays on 127.0.0.1:3001');
  }
  if (options.lan) {
    deps.log('  WARNING: --lan publishes proxy/dashboard on 0.0.0.0; prefer --remote on untrusted WiFi');
  }
  if (options.netemProfile !== 'off') {
    deps.log(`  netem:     ${options.netemProfile} on ${options.iface} (egress-only, ~20 ms RTT for wan)`);
  }
  deps.log('  stubs:     3 replicas behind upstream DNS round-robin');
  deps.log('             verify: docker compose logs proxy | grep upstreams');
  if (options.remote || options.lan) {
    deps.log('');
    deps.log('On Laptop B:');
    deps.log(`  curl http://${host}:8080/health`);
    deps.log(
      `  node stress-test/dist/index.js --target http://${host}:8080 ` +
        `--collector http://${host}:3000 --duration 30000 --concurrency 64 ` +
        `--ramp 5000 --label cross-machine`,
    );
    deps.log('Redis stays on the compose network; B only posts HTTP aggregates.');
  }
  deps.log('');
  deps.log(`Tear down with ${options.sudo ? 'SUDO=1 ' : ''}./down.sh.`);
}

export async function up(options, deps = defaultDeps) {
  preflight(options, deps);
  let stackStarted = false;
  try {
    if (!options.skipCaptureCheck) {
      const captured = run(deps, options, 'capture-check', 'bash',
        ['tools/capture-check.sh', options.iface], { allowFailure: true });
      if (captured.ok === false && captured.code === 124) {
        deps.log('WARN capture-check timed out with no traffic — start Laptop B to generate it');
      }
    }

    stackStarted = true;
    const [command, args] = composeCommand(options);
    run(deps, options, 'compose-up', command, [...args, 'up', '-d', '--wait', '--scale', 'stub=3'], {
      env: composeEnv(options),
    });

    const host = serviceHost(options);
    for (const [name, url] of [
      ['proxy-health', `http://${host}:8080/health`],
      ['collector-time', `http://${host}:3000/api/time`],
    ]) {
      const result = await waitForHttp(url, { fetchImpl: deps.fetch, sleep: deps.sleep });
      if (!result.ok) {
        const last = result.lastError === '' ? `HTTP ${result.lastStatus}` : result.lastError;
        throw new HarnessError(
          name,
          `${url} not ready after ${result.attempts} attempts (last: ${last})`,
        );
      }
      deps.log(`OK ${name}: ${url} (attempt ${result.attempts})`);
    }
    await verifyCollector(options, deps);
    await verifyServices(options, deps);

    if (options.netemProfile !== 'off') {
      run(deps, options, 'netem-up', 'bash', ['tools/netem-up.sh', options.iface, options.netemProfile]);
      const shown = run(deps, options, 'qdisc-check', 'tc', ['qdisc', 'show', 'dev', options.iface]);
      if (!shown.stdout.includes('netem')) {
        throw new HarnessError(
          'qdisc-check',
          `expected a netem qdisc on ${options.iface}, got: ${shown.stdout.trim()}`,
        );
      }
    }

    printSummary(options, deps);
  } catch (error) {
    if (stackStarted) {
      deps.log('Rolling back partial stack after failure...');
      try {
        await down(options, deps);
        deps.log('OK rollback');
      } catch (rollbackError) {
        deps.log(`WARN rollback failed: ${rollbackError.message}`);
      }
    }
    throw error;
  }
}

export async function down(options, deps = defaultDeps) {
  const failures = [];
  const attempt = (action) => {
    try {
      action();
    } catch (error) {
      failures.push(error);
      deps.log(`WARN ${error.message}`);
    }
  };

  attempt(() => {
    if (options.netemProfile !== 'off') {
      run(deps, options, 'netem-down', 'bash', ['tools/netem-down.sh', options.iface]);
    }
    const shown = run(deps, options, 'qdisc-check', 'tc', ['qdisc', 'show', 'dev', options.iface]);
    if (/\bnetem\b/u.test(shown.stdout)) {
      throw new HarnessError(
        'qdisc-check',
        `netem is still applied on ${options.iface}: ${shown.stdout.trim()}`,
      );
    }
  });

  const [command, args] = composeCommand(options);
  attempt(() => {
    run(deps, options, 'compose-down', command, [...args, 'down', '-v', '--remove-orphans'], {
      env: composeEnv(options),
    });
  });

  if (failures.length > 0) {
    throw new HarnessError('teardown', failures.map((error) => error.message).join('\n'));
  }
  deps.log('Stack down: containers removed, no netem qdisc left.');
}

export async function main(argv = process.argv.slice(2), deps = defaultDeps) {
  let options;
  try {
    options = parseArgs(argv, deps.env);
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  try {
    if (options.command === 'up') await up(options, deps);
    else await down(options, deps);
    return 0;
  } catch (error) {
    console.error(`FAILED: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
