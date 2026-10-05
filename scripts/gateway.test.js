'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer } = require('./test-support');
test('invalid HTTP input is rejected without taking down the gateway', async () => {
  await withServer(async ({ api, port }) => {
    assert.equal((await api('/api/%ZZ')).status, 400);
    assert.equal((await api('/api/me', undefined, 'yun_token=%ZZ')).status, 400);
    for (const body of ['{', 'null', '[]']) {
      const res = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', body });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, 'INVALID_JSON');
    }
    const res = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', body: JSON.stringify({ padding: '中'.repeat(100000) }) });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).code, 'BODY_TOO_LARGE');
    assert.equal((await api('/api/health')).json.ok, true);
  });
});
