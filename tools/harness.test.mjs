import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ROOT,
  composeCommand,
  displayHost,
  down,
  expectedBindings,
  findPortConflicts,
  formatCommand,
  parseArgs,
  parseListeners,
  serviceHost,
  up,
  verifyCollector,
  waitForHttp,
  withSudo,
} from './harness.mjs';

function makeDeps(overrides = {}) {
  const calls = [];
  const deps = {
    calls,
    env: {},
    existsSync: () => true,
    isRoot: () => true,
    log: () => {},
    exec(command, args) {
      calls.push([command, ...args].join(' '));
      return { code: 0, stdout: '', stderr: '' };
    },
    fetch: async (url, init) => {
      calls.push(`FETCH ${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/api/time')) {
        return { ok: true, status: 200, json: async () => ({ now: 1_700_000_000_000 }) };
      }
      if (url.endsWith('/api/aggregates')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.endsWith('/api/services')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            services: [
              { name: 'proxy', status: 'up' },
              { name: 'redis', status: 'up' },
            ],
          }),
        };
      }
      return { ok: true, status: 200 };
    },
    sleep: async () => {},
  };
  return { ...deps, ...overrides, calls };
}

test('parseArgs rejects mixing remote and LAN modes', () => {
  assert.throws(
    () => parseArgs(['up', '--remote', '--lan', '--lan-ip', '192.168.1.5'], {}),
    /mutually exclusive/u,
  );
  const lan = parseArgs(['up', '--lan', '--lan-ip', '192.168.1.5'], {});
  assert.equal(lan.lan, true);
  assert.equal(lan.lanIp, '192.168.1.5');
  assert.equal(lan.remote, false);
});

test('composeCommand adds the LAN override only in LAN mode', () => {
  assert.deepEqual(composeCommand({ remote: false, lan: false }), [
    'docker',
    ['compose', '-f', 'docker-compose.yml'],
  ]);
  assert.deepEqual(composeCommand({ remote: false, lan: true }), [
    'docker',
    ['compose', '-f', 'docker-compose.yml', '-f', 'compose.lan-harness.yml'],
  ]);
});

test('LAN mode expects wildcard bindings and prints the LAN IP', () => {
  const options = { lan: true, lanIp: '192.168.1.5', remote: false, tailscaleIp: null };
  assert.deepEqual(expectedBindings(options), [
    { host: '0.0.0.0', port: 3000 },
    { host: '0.0.0.0', port: 8080 },
    { host: '127.0.0.1', port: 3001 },
    { host: '127.0.0.1', port: 3002 },
    { host: '127.0.0.1', port: 3003 },
  ]);
  assert.equal(serviceHost(options), '127.0.0.1');
  assert.equal(displayHost(options), '192.168.1.5');
});

test('parseArgs applies defaults', () => {
  const options = parseArgs(['up'], {});
  assert.equal(options.command, 'up');
  assert.equal(options.netemProfile, 'wan');
  assert.equal(options.iface, 'wlp0s20f3');
  assert.equal(options.remote, false);
  assert.equal(options.tailscaleIp, null);
  assert.equal(options.sudo, false);
});

test('parseArgs reads flags and environment', () => {
  const options = parseArgs(
    ['down', '--remote', '--tailscale-ip', '100.1.2.3', '--netem', 'off', '--iface', 'enp1s0'],
    { SUDO: '1' },
  );
  assert.equal(options.command, 'down');
  assert.equal(options.remote, true);
  assert.equal(options.tailscaleIp, '100.1.2.3');
  assert.equal(options.netemProfile, 'off');
  assert.equal(options.iface, 'enp1s0');
  assert.equal(options.sudo, true);
});

test('parseArgs rejects an unknown netem profile', () => {
  assert.throws(() => parseArgs(['up', '--netem', 'turbo'], {}), /--netem must be one of/u);
});

test('composeCommand adds the Tailscale override only in remote mode', () => {
  assert.deepEqual(composeCommand({ remote: false }), [
    'docker',
    ['compose', '-f', 'docker-compose.yml'],
  ]);
  assert.deepEqual(composeCommand({ remote: true }), [
    'docker',
    ['compose', '-f', 'docker-compose.yml', '-f', 'compose.tailscale.yml'],
  ]);
});

test('withSudo and formatCommand render diagnosable commands', () => {
  assert.deepEqual(withSudo('docker', ['compose', 'up'], true), [
    'sudo',
    ['docker', 'compose', 'up'],
  ]);
  assert.deepEqual(withSudo('docker', ['compose', 'up'], false), [
    'docker',
    ['compose', 'up'],
  ]);
  assert.equal(formatCommand('bash', ['tools/a b.sh', 'wan']), 'bash "tools/a b.sh" wan');
});

test('waitForHttp retries until a healthcheck succeeds', async () => {
  let attempts = 0;
  const result = await waitForHttp('http://127.0.0.1:8080/health', {
    fetchImpl: async () => {
      attempts += 1;
      return attempts < 3 ? { ok: false, status: 503 } : { ok: true, status: 200 };
    },
    sleep: async () => {},
    timeoutMs: 3_000,
    intervalMs: 1_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(attempts, 3);
});

test('waitForHttp reports the last failure after the attempt budget', async () => {
  const result = await waitForHttp('http://127.0.0.1:3000/api/time', {
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    sleep: async () => {},
    timeoutMs: 2_000,
    intervalMs: 1_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.match(result.lastError, /ECONNREFUSED/u);
});

test('up waits for host health before applying netem and checks the qdisc', async () => {
  const deps = makeDeps({
    exec(command, args) {
      const call = [command, ...args].join(' ');
      deps.calls.push(call);
      if (call.includes('qdisc show')) {
        return { code: 0, stdout: 'qdisc netem 8001: dev wlp0s20f3', stderr: '' };
      }
      return { code: 0, stdout: '27', stderr: '' };
    },
  });
  const options = { ...parseArgs(['up'], {}), skipCaptureCheck: true };

  await up(options, deps);

  const calls = deps.calls;
  const composeUp = calls.findIndex((call) => call.includes('up -d --wait --scale stub=3'));
  const firstFetch = calls.findIndex((call) => call.startsWith('FETCH '));
  const netemUp = calls.findIndex((call) => call.includes('netem-up.sh'));
  const qdiscCheck = calls.findIndex((call) => call.includes('qdisc show'));
  assert.ok(composeUp >= 0);
  assert.ok(firstFetch > composeUp);
  assert.ok(netemUp > firstFetch);
  assert.ok(qdiscCheck > netemUp);
  assert.ok(!calls.some((call) => call.includes('capture-check.sh')));
});

test('down keeps tearing down when netem removal fails', async () => {
  const deps = makeDeps({
    exec(command, args) {
      const call = [command, ...args].join(' ');
      deps.calls.push(call);
      if (call.includes('netem-down.sh')) {
        return { code: 1, stdout: '', stderr: 'permission denied' };
      }
      return { code: 0, stdout: 'qdisc mq 0: dev wlp0s20f3', stderr: '' };
    },
  });

  await assert.rejects(down(parseArgs(['down'], {}), deps), /teardown/u);
  assert.ok(deps.calls.some((call) => call.includes('netem-down.sh')));
  assert.ok(deps.calls.some((call) => call.includes('down -v --remove-orphans')));
});

test('capture-check reports both traffic and no traffic', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lambda-capture-'));
  const fake = path.join(dir, 'tshark');
  writeFileSync(
    fake,
    '#!/usr/bin/env bash\nfor ((i=0;i<${FAKE_PACKETS:-0};i++)); do echo frame; done\n',
  );
  chmodSync(fake, 0o755);

  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_PACKETS: '0' };
  const empty = spawnSync('bash', ['tools/capture-check.sh', 'fake0', '1'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /NO TRAFFIC/u);

  env.FAKE_PACKETS = '3';
  const traffic = spawnSync('bash', ['tools/capture-check.sh', 'fake0', '1'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  assert.equal(traffic.status, 0);
  assert.match(traffic.stdout, /traffic present/u);
  assert.doesNotMatch(traffic.stdout, /command not found/u);

  rmSync(dir, { recursive: true, force: true });
});

test('verifyCollector rejects a stale dashboard image that serves HTML', async () => {
  const urls = [];
  const deps = makeDeps({
    fetch: async (url) => {
      urls.push(url);
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });

  await assert.rejects(
    verifyCollector(parseArgs(['up'], {}), deps),
    /dashboard image may be stale/u,
  );
  assert.equal(urls[0], 'http://127.0.0.1:3000/api/time');
});

test('expectedBindings and serviceHost switch with remote mode', () => {
  const local = parseArgs(['up'], {});
  assert.deepEqual(expectedBindings(local), [
    { host: '127.0.0.1', port: 3000 },
    { host: '127.0.0.1', port: 3001 },
    { host: '127.0.0.1', port: 3002 },
    { host: '127.0.0.1', port: 3003 },
    { host: '127.0.0.1', port: 8080 },
  ]);
  assert.equal(serviceHost(local), '127.0.0.1');

  const remote = { ...local, remote: true, tailscaleIp: '100.64.0.1' };
  assert.deepEqual(expectedBindings(remote), [
    { host: '127.0.0.1', port: 3001 },
    { host: '127.0.0.1', port: 3002 },
    { host: '127.0.0.1', port: 3003 },
    { host: '100.64.0.1', port: 8080 },
    { host: '100.64.0.1', port: 3000 },
  ]);
  assert.equal(serviceHost(remote), '100.64.0.1');
});

test('parseListeners and findPortConflicts catch loopback and wildcard owners', () => {
  const listeners = parseListeners(
    'Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port\n' +
      'LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:*\n' +
      'LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:*\n' +
      'LISTEN 0 4096 127.0.0.1:5000 0.0.0.0:*',
  );
  const conflicts = findPortConflicts(listeners, [
    { host: '127.0.0.1', port: 3000 },
    { host: '100.64.0.1', port: 8080 },
    { host: '127.0.0.1', port: 3001 },
  ]);
  assert.equal(conflicts.length, 2);
  assert.match(conflicts[0].listener, /127\.0\.0\.1:3000/u);
  assert.match(conflicts[1].listener, /0\.0\.0\.0:8080/u);
});

test('up refuses to start when a published port is already occupied', async () => {
  const deps = makeDeps({
    exec(command, args) {
      deps.calls.push([command, ...args].join(' '));
      if (args[0] === '-ltn') {
        return { code: 0, stdout: 'LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:*\n', stderr: '' };
      }
      return { code: 0, stdout: '27', stderr: '' };
    },
  });

  await assert.rejects(
    up({ ...parseArgs(['up'], {}), skipCaptureCheck: true }, deps),
    /ports already in use/u,
  );
  assert.ok(!deps.calls.some((call) => call.includes('up -d --wait')));
});

test('up rolls back a partial stack when compose-up fails', async () => {
  const deps = makeDeps({
    exec(command, args) {
      const call = [command, ...args].join(' ');
      deps.calls.push(call);
      if (call.includes('up -d --wait')) {
        return { code: 1, stdout: '', stderr: 'address already in use' };
      }
      if (call.includes('qdisc show')) {
        return { code: 0, stdout: 'qdisc mq 0: dev wlp0s20f3', stderr: '' };
      }
      return { code: 0, stdout: '27', stderr: '' };
    },
  });

  await assert.rejects(
    up({ ...parseArgs(['up'], {}), skipCaptureCheck: true }, deps),
    /compose-up/u,
  );
  assert.ok(deps.calls.some((call) => call.includes('netem-down.sh')));
  assert.ok(deps.calls.some((call) => call.includes('down -v --remove-orphans')));
});
