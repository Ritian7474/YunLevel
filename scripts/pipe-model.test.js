'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EngineSession } = require('../server/engine-session');
const { ROOT, removeTestDir, withServer } = require('./test-support');

for (const model of ['tank', 'hx']) {
  test(`${model}: student processes disable feedforward even in a saved teacher state`, async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, '.test-data-pipe-bias-'));
    const executable = process.platform === 'win32'
      ? path.join(ROOT, model === 'tank' ? 'native/build/YunEngine.exe' : 'native-hx/build/HxEngine.exe')
      : path.join(ROOT, 'bin', model === 'tank' ? 'YunEngine' : 'HxEngine');
    const options = { studentId: 'bias', modelId: model, enginePath: executable,
      stateDir: dir, historyDir: dir };
    const teacher = new EngineSession({ ...options, ownerRole: 'teacher' });
    let student;
    try {
      await teacher.start();
      assert.equal((await teacher.send('SET_BIAS 1')).bias, true);
      await teacher.send('SAVE');
      await teacher.stop();
      student = new EngineSession({ ...options, ownerRole: 'student' });
      assert.equal((await student.start()).bias, false);
      assert.equal((await student.send('SET_BIAS 1')).bias, false);
      assert.equal((await student.send('RESET')).bias, false);
      if (model === 'tank') assert.equal((await student.send('HIGH_SCORE')).bias, false);
      await student.send('LOOP_CLEAR');
      await student.send(`LOOP_ADD ${model === 'tank' ? 2 : 0} 0`);
      await student.send('SET_PID loop 0 0.5 700 120 -1 0 0');
      await student.send('START');
      const state = await student.send('TICK 1');
      assert.equal(state.bias, false);
      assert.equal(state.loops[0].uBias, 0);
    } finally {
      await teacher.stop();
      if (student) await student.stop();
      removeTestDir(dir);
    }
  });
}

test('student cannot toggle feedforward through HTTP, teacher toggle remains available', async () => {
  await withServer(async ({ api, cmd, teacher }) => {
    const t = await teacher();
    assert.equal((await cmd(t.cookie, 'SET_BIAS 1')).json.state.bias, true);
    const cls = (await api('/api/teacher/classes', undefined, t.cookie)).json.classes[0];
    await api(`/api/teacher/classes/${cls.id}/students`, { studentId: 'PIPE1', name: 'Pipe' }, t.cookie);
    const s = await api('/api/login', { classCode: 'CORE26', studentId: 'PIPE1', name: 'Pipe' });
    assert.equal(s.json.state.bias, false);
    for (const command of ['SET_BIAS 1', 'SET_BIAS 0']) {
      const response = await cmd(s.cookie, command);
      assert.equal(response.status, 403);
      assert.equal(response.json.code, 'COMMAND_FORBIDDEN');
    }
  });
});
