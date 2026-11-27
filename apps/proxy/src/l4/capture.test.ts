import test from 'node:test';
import assert from 'node:assert/strict';

import { startCapture } from './capture.js';

test('an unset CAPTURE_IFACE disables capture without an error', () => {
  const logs: string[] = [];
  let errors = 0;
  const handle = startCapture({
    iface: '',
    onPacket: () => {},
    log: (line) => { logs.push(line); },
    onError: () => { errors += 1; },
  });

  assert.equal(handle.started, false);
  assert.equal(errors, 0);
  assert.deepEqual(logs, ['capture disabled: CAPTURE_IFACE is not set']);
});
