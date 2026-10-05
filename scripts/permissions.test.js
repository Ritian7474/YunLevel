'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer } = require('./test-support');
test('student tuning is allowed, teacher rules and internal commands are protected', async () => {
  await withServer(async ({ api,cmd,teacher }) => {
    const t = await teacher();
    const cls = (await api('/api/teacher/classes',undefined,t.cookie)).json.classes[0];
    await api(`/api/teacher/classes/${cls.id}/students`,{studentId:'S1',name:'One'},t.cookie);
    await api('/api/teacher/settings',{scoreSystemOn:true,scoreConfig:{sp3:65,modeTank:1}},t.cookie);
    const s = await api('/api/login',{classCode:'CORE26',studentId:'S1',name:'One'});
    for (const command of ['SET_BIAS 1','SET_BIAS 0','HIGH_SCORE','PRESET','TEMPLATE_A','SET_SP 2 20','SET_FLOW_SP 0 20','SET_PVX_SP 0 20',
      'SCORE_CFG 60 120 10 20 0 0 0','SCORE_MODE 2','SCORE_TANK 0','TICK 1','SAVE','QUIT','DEACTIVATE','SCORE_FINISH']) {
      assert.equal((await cmd(s.cookie,command)).status,403,command);
    }
    assert.equal((await cmd(s.cookie,'LOOP_ADD 2 1')).status,200);
    assert.equal((await cmd(s.cookie,'SET_PID loop 0 2 10 0 1 0 0')).status,200);
    assert.equal((await cmd(s.cookie,'SET_PUMP 50')).status,200);
    assert.equal((await api('/api/current/import',{},s.cookie)).status,403);
    assert.equal((await api('/api/projects/import',{},s.cookie)).status,403);
    const saved = await api('/api/projects/2/save',{},s.cookie);
    assert.equal(saved.status,200);
    const first = await cmd(s.cookie,'SCORE_START');
    assert.equal(first.status,200);
    assert.ok(first.json.state.score.attemptId);
    assert.equal(first.json.state.sp3,65);
    assert.equal((await api('/api/projects/2/restore',{},s.cookie)).status,409);
    await cmd(s.cookie,'RESET');
    const restored = await api('/api/projects/2/restore',{},s.cookie);
    assert.equal(restored.status,200);
    assert.equal(restored.json.state.score.active,false);
    assert.equal(restored.json.state.sim_time,0);
    assert.equal(restored.json.state.sp3,65);
    assert.equal(restored.json.state.nLoop, 1);
    const next = await cmd(s.cookie,'SCORE_START');
    assert.notEqual(next.json.state.score.attemptId,first.json.state.score.attemptId);
    await cmd(s.cookie, 'RESET');
    const raced = await Promise.all([cmd(s.cookie, 'SCORE_START'), api('/api/projects/2/restore', {}, s.cookie)]);
    assert.ok([200, 409].includes(raced[0].status));
    assert.ok([200, 409].includes(raced[1].status));
    const afterRace = (await cmd(s.cookie, 'STATE')).json.state;
    assert.equal(afterRace.score.active, raced[0].status === 200);
    if (raced[0].status === 200) assert.equal(afterRace.score.attemptId, raced[0].json.state.score.attemptId);
    const records = (await api('/api/teacher/records', undefined, t.cookie)).json.records;
    assert.equal(records.length, 2);
    assert.ok(records.every(record => record.attemptId && record.score.total === 0));
  });
});
