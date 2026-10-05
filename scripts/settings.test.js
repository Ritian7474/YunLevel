'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { withServer } = require('./test-support');
test('merged versioned rules preserve targets, select system fields and defer active attempts', async () => {
  await withServer(async ({ api, cmd, teacher, dataDir }) => {
    const t = await teacher();
    const cls = (await api('/api/teacher/classes', undefined, t.cookie)).json.classes[0];
    for (const [studentId,name] of [['S1','One'],['S2','Two']]) await api(`/api/teacher/classes/${cls.id}/students`, { studentId,name }, t.cookie);
    let result = await api('/api/teacher/settings', { openModels: { hx: true }, scoreSystemOn: true,
      scoreConfig: { sp1:65, spHx:450, initTempHx:400, durationUnit:900, sysSp1:70, sysSpHx:460 } }, t.cookie);
    assert.equal(result.json.settings.scoreSystemOn, true);
    const student = await api('/api/login', { classCode:'CORE26', studentId:'S1', name:'One', model:'tank' });
    const hx = await api('/api/login', { classCode:'CORE26', studentId:'S2', name:'Two', model:'hx' });
    assert.equal(hx.json.state.sp, 450);
    assert.equal(hx.json.state.ti1103, 400);
    const revision = result.json.settings.scoreConfigRevision;
    assert.equal(hx.json.state.score.configRevision, revision);
    assert.equal(hx.json.state.score.effectiveConfig.targets[0], 450);
    result = await api('/api/teacher/settings', { scoreConfig:{ durationUnit:1000 } }, t.cookie);
    assert.equal(result.json.settings.scoreConfig.sp1, 65);
    assert.equal((await api('/api/state', undefined, student.cookie)).json.state.sp1, 65);
    assert.equal(result.json.settings.scoreConfigRevision, revision + 1);
    assert.equal((await api('/api/state', undefined, student.cookie)).json.state.score.configRevision, revision + 1);
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir,'settings.json'),'utf8'));
    assert.equal(persisted.scoreSystemOn, true);
    assert.equal((await api('/api/teacher/settings', { scoreConfig:{ bandTank:0 } }, t.cookie)).status, 400);
    assert.equal((await api('/api/projects', undefined, t.cookie)).json.settings.scoreConfigRevision, revision + 1);
    await cmd(student.cookie, 'START');
    await cmd(hx.cookie, 'START');
    result = await api('/api/teacher/settings', { scoreConfig:{ modeTank:2, modeHx:2 } }, t.cookie);
    assert.ok(result.json.applications.every(item => item.status === 'applied'));
    for (const cookie of [student.cookie, hx.cookie]) {
      const state = (await api('/api/state', undefined, cookie)).json.state;
      assert.equal(state.running, true);
      assert.equal(state.score.mode, 2);
      assert.equal(state.score.configRevision, result.json.settings.scoreConfigRevision);
    }
    assert.equal((await api('/api/state', undefined, student.cookie)).json.state.sp1, 70);
    assert.equal((await api('/api/state', undefined, hx.cookie)).json.state.sp, 460);
    await cmd(student.cookie, 'RESET');
    await cmd(student.cookie,'SCORE_START');
    await cmd(t.cookie, 'SCORE_START');
    const current = (await api('/api/state', undefined, student.cookie)).json.state;
    result = await api('/api/teacher/settings', { scoreConfig:{ sysSp1:80, durationSystem:1800 } }, t.cookie);
    assert.ok(result.json.applications.some(item => item.studentId === 'S1' && item.status === 'pending'));
    const unchanged = (await api('/api/state', undefined, student.cookie)).json.state;
    assert.equal(unchanged.sp1, current.sp1);
    assert.equal(unchanged.score.durationS, current.score.durationS);
    await cmd(t.cookie, 'RESET');
    const nextTeacher = (await cmd(t.cookie, 'SCORE_START')).json.state;
    assert.equal(nextTeacher.score.configRevision, result.json.settings.scoreConfigRevision);
    assert.equal(nextTeacher.score.durationS, 1800);
  });
});
