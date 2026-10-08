'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withServer, sleep } = require('./test-support');
async function setup(api, teacher) {
  const t = await teacher();
  const cls = (await api('/api/teacher/classes', undefined, t.cookie)).json.classes[0];
  await api(`/api/teacher/classes/${cls.id}/students`, { studentId: 'S1', name: 'One' }, t.cookie);
  await api('/api/teacher/settings', { scoreSystemOn: true, openModels: { hx: true }, scoreConfig: { durationUnit: 900, sp3: 65 } }, t.cookie);
  const login = model => api('/api/login', { classCode: 'CORE26', studentId: 'S1', name: 'One', model });
  return { t, cls, login };
}
test('close, logout and reset seal one zero record; stale pages cannot end a new round', async () => {
  await withServer(async ({ api, cmd, teacher }) => {
    const { t, cls, login } = await setup(api, teacher);
    let s = await login('tank');
    await api('/api/projects/2/save', {}, s.cookie);
    let started = await cmd(s.cookie, 'SCORE_START');
    await api('/api/projects/2/save', {}, s.cookie);
    const first = started.json.state.score.attemptId;
    await api(`/api/teacher/command/${cls.id}/S1`, { cmd: 'TICK 1' }, t.cookie);
    const end = { sessionId: s.json.sessionId, attemptId: first };
    const results = await Promise.all([api('/api/session/end', end, s.cookie), api('/api/session/end', end, s.cookie)]);
    assert.ok(results.every(r => r.status === 200));
    let records = (await api('/api/teacher/records', undefined, t.cookie)).json.records;
    assert.equal(records.length, 1);
    assert.equal(records[0].score.total, 0);
    assert.equal(records[0].scoreTime, 1);
    assert.equal(records[0].endReason, 'page_closed');
    s = await login('tank');
    assert.equal(s.json.state.score.active, false);
    assert.equal(s.json.state.sim_time, 0);
    const restore = await api('/api/projects/2/restore', {}, s.cookie);
    assert.equal(restore.json.state.score.active, false);
    started = await cmd(s.cookie, 'SCORE_START');
    assert.notEqual(started.json.state.score.attemptId, first);
    assert.equal((await api('/api/session/end', end, s.cookie)).status, 409);
    await api('/api/teacher/settings', { scoreConfig: { sp3: 72 } }, t.cookie);
    assert.equal((await cmd(s.cookie, 'STATE')).json.state.sp3, 65);
    assert.equal((await cmd(s.cookie, 'RESET')).status, 200);
    records = (await api('/api/teacher/records', undefined, t.cookie)).json.records;
    assert.equal(records.length, 2);
    assert.equal(records[1].score.total, 0);
    assert.equal(records[1].endReason, 'reset');
    const third = await cmd(s.cookie, 'SCORE_START');
    assert.equal(third.json.state.sp3, 72);
    assert.notEqual(third.json.state.score.attemptId, started.json.state.score.attemptId);
    await api('/api/logout', {}, s.cookie);
    records = (await api('/api/teacher/records', undefined, t.cookie)).json.records;
    assert.equal(records.length, 3);
    assert.equal(records[2].endReason, 'logout');
    s = await login('hx');
    started = await cmd(s.cookie, 'SCORE_START');
    await api('/api/session/end', { sessionId: s.json.sessionId, attemptId: started.json.state.score.attemptId }, s.cookie);
    const hx = (await api('/api/teacher/records?model=hx', undefined, t.cookie)).json.records;
    assert.equal(hx.length, 1);
    assert.equal(hx[0].score.total, 0);
    assert.equal(hx[0].endReason, 'page_closed');
  });
});
test('restart journal seals interrupted IDs exactly once without changing legacy records', async () => {
  await withServer(async ({ teacher, api, dataDir }) => {
    const t = await teacher();
    const records = (await api('/api/teacher/records', undefined, t.cookie)).json.records;
    assert.equal(records.length, 2);
    assert.equal(records[0].score.total, 84);
    assert.equal(records[1].attemptId, 'interrupted-id');
    assert.equal(records[1].score.total, 0);
    assert.equal(records[1].scoreTime, 37);
    assert.equal(records[1].endReason, 'server_restart');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'active-attempts.json'))), {});
  }, {}, dataDir => {
    fs.writeFileSync(path.join(dataDir, 'score_records.jsonl'), JSON.stringify({ modelId: 'tank', score: { total: 84 } }) + '\n');
    fs.writeFileSync(path.join(dataDir, 'active-attempts.json'), JSON.stringify({ 'interrupted-id': {
      attempt: { id: 'interrupted-id', revision: 2, config: {}, startedAt: new Date().toISOString() },
      state: { score: { active: true, sessionT: 37, total: 90 } }, modelId: 'tank', ownerRole: 'student',
      classId: 'c', studentId: 's', sessionKey: 'c:s',
    } }));
  });
});
test('heartbeats keep a session alive; silence seals it and revokes login', async () => {
  await withServer(async ({ api, cmd, teacher }) => {
    const { login } = await setup(api, teacher);
    const s = await login('tank');
    const started = await cmd(s.cookie, 'SCORE_START');
    const beat = { sessionId: s.json.sessionId, attemptId: started.json.state.score.attemptId };
    for (let i = 0; i < 5; i++) { await sleep(400); assert.equal((await api('/api/session/heartbeat', beat, s.cookie)).status, 200); }
    assert.equal((await api('/api/state', undefined, s.cookie)).json.state.score.active, true);
    await sleep(1900);
    let me = await api('/api/me', undefined, s.cookie);
    for (let i = 0; me.status !== 401 && i < 15; i++) { await sleep(100); me = await api('/api/me', undefined, s.cookie); }
    assert.equal(me.status, 401);
    const next = await login('tank');
    assert.equal(next.status, 200);
    const record = (await api('/api/score-record', undefined, next.cookie)).json.record;
    assert.equal(record.endReason, 'heartbeat_timeout');
    assert.equal(record.score.total, 0);
    assert.equal(next.json.state.score.active, false);
  }, { YUN_SESSION_TIMEOUT_MS: '1500' });
});
