import test from 'node:test';
import assert from 'node:assert/strict';

import { services } from './services.js';

test('services keeps a valid displayUrl and drops an invalid one', () => {
  const previous = process.env.DASHBOARD_SERVICES;
  process.env.DASHBOARD_SERVICES = JSON.stringify([
    {
      name: 'dashboard',
      url: 'http://127.0.0.1:3000',
      displayUrl: 'http://100.64.0.1:3000',
      healthPath: '/api/time',
    },
    { name: 'bad', url: 'http://127.0.0.1:3100', displayUrl: 7 },
  ]);

  try {
    const parsed = services();
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.displayUrl, 'http://100.64.0.1:3000');
    assert.equal(parsed[0]?.url, 'http://127.0.0.1:3000');
  } finally {
    if (previous === undefined) delete process.env.DASHBOARD_SERVICES;
    else process.env.DASHBOARD_SERVICES = previous;
  }
});
