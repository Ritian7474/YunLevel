'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer } = require('./test-support');
test('teacher observers attach, cannot write, and inherit control without reset', async () => {
  await withServer(async ({ api, cmd, teacher }) => {
    const controller = await teacher();
    await cmd(controller.cookie, 'SET_SP 2 67');
    await cmd(controller.cookie, 'START');
    await cmd(controller.cookie, 'TICK 1');
    const a = await teacher();
    const b = await teacher();
    assert.equal(a.json.viewOnly, true);
    assert.equal(a.json.state.sp3, 67);
    assert.equal(a.json.state.running, true);
    for (const [url, body] of [
      ['/api/command', { cmd: 'RESET' }], ['/api/teacher/settings', { scoreSystemOn: true }],
      ['/api/teacher/classes', { name: 'blocked', code: 'BLOCK' }], ['/api/current/restore', {}],
      ['/api/curve-clear', {}], ['/api/teacher/clear', {}],
    ]) {
      const result = await api(url, body, a.cookie);
      assert.equal(result.status, 403, url);
      assert.equal(result.json.code, 'VIEW_ONLY');
    }
    await api('/api/logout', {}, b.cookie);
    assert.equal((await api('/api/state', undefined, controller.cookie)).json.state.running, true);
    const c = await teacher();
    await api('/api/logout', {}, controller.cookie);
    assert.equal((await api('/api/me', undefined, a.cookie)).json.viewOnly, false);
    assert.equal((await api('/api/me', undefined, c.cookie)).json.viewOnly, true);
    const state = (await cmd(a.cookie, 'STATE')).json.state;
    assert.equal(state.sp3, 67);
    assert.equal(state.running, true);
    assert.equal((await cmd(c.cookie, 'PAUSE')).status, 403);
    assert.equal((await cmd(a.cookie, 'PAUSE')).status, 200);
  });
});
