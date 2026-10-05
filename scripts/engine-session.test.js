'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EngineSession } = require('../server/engine-session');
const { ROOT, sleep, removeTestDir, withServer } = require('./test-support');
async function fakeEngine(run) {
  const dir = fs.mkdtempSync(path.join(ROOT, '.test-data-queue-'));
  const e = new EngineSession({ studentId: 'queue', enginePath: process.execPath,
    engineArgs: [path.join(__dirname, 'fixtures/slow-engine.cjs')], stateDir: dir, historyDir: dir });
  try { await e.start(); await run(e); }
  finally { await e.stop(); removeTestDir(dir); }
}
test('native transport has one inflight command, FIFO replies and a bounded queue', async () => {
  await fakeEngine(async e => {
    const first = e.send('DELAY 150');
    const queue = Array.from({ length: 64 }, () => e.send('STATE'));
    assert.equal(e.pending.length, 64);
    assert.equal(e.inflight.command, 'DELAY 150');
    await assert.rejects(e.send('STATE'), { code: 'ENGINE_BUSY' });
    const results = await Promise.all([first, ...queue]);
    assert.deepEqual(results.map(r => r.serial), Array.from({ length: 65 }, (_, i) => i + 1));
    assert.equal(e.pending.length, 0);
    assert.equal(e.inflight, null);
  });
});
test('timeout rejects all waiting items, kills the desynchronized kernel and ignores late output', async () => {
  await fakeEngine(async e => {
    const pid = e.child.pid;
    const closed = new Promise(resolve => e.once('closed', resolve));
    const delayed = e.send('DELAY 500', 50);
    const waiting = e.send('STATE');
    const results = await Promise.allSettled([delayed, waiting]);
    assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === 'ENGINE_TIMEOUT'));
    await closed;
    assert.equal(e.exited, true);
    assert.equal(e.closed, true);
    assert.equal(e.pending.length, 0);
    assert.equal(e.inflight, null);
    e._onStdout('{"type":"state","serial":999}\n');
    assert.equal(e.lastState.serial, 0);
    assert.throws(() => process.kill(pid, 0));
    await assert.rejects(e.send('STATE'), { code: 'ENGINE_TIMEOUT' });
  });
});
test('stop distinguishes stopping from exited and kills a process that acknowledges QUIT but stays alive', async () => {
  await fakeEngine(async e => {
    const pid = e.child.pid;
    const stop = e.stop();
    assert.equal(e.stopping, true);
    assert.equal(e.closed, false);
    await assert.rejects(e.send('STATE'), { code: 'ENGINE_CLOSED' });
    await stop;
    assert.equal(e.exited, true);
    assert.throws(() => process.kill(pid, 0));
  });
});
test('a crashing command rejects its reply and the remaining queue exactly once', async () => {
  await fakeEngine(async e => {
    let closedCount = 0;
    e.on('closed', () => closedCount++);
    const results = await Promise.allSettled([e.send('DELAY 50'), e.send('CRASH'), e.send('STATE')]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].reason.code, 'ENGINE_EXITED');
    assert.equal(results[2].reason.code, 'ENGINE_EXITED');
    assert.equal(closedCount, 1);
    assert.equal(e.pending.length, 0);
  });
});
test('unexpected kernel death seals the active assessment and prevents a resumed login', async () => {
  await withServer(async ({ teacher, api, cmd, dataDir }) => {
    const t = await teacher();
    const cls = (await api('/api/teacher/classes', undefined, t.cookie)).json.classes[0];
    await api(`/api/teacher/classes/${cls.id}/students`, { studentId: 'S1', name: 'One' }, t.cookie);
    await api('/api/teacher/settings', { scoreSystemOn: true }, t.cookie);
    const login = () => api('/api/login', { classCode: 'CORE26', studentId: 'S1', name: 'One' });
    const s = await login();
    const start = await cmd(s.cookie, 'SCORE_START');
    // Use the native PID from the process inventory, scoped to this test's runtime path.
    const { execFileSync } = require('node:child_process');
    let pid;
    if (process.platform === 'win32') {
      const escaped = path.join(dataDir, 'runtime').replace(/'/g, "''");
      const output = execFileSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'YunEngine.exe' -and $_.CommandLine -like '*${escaped}*' } | Select-Object -ExpandProperty ProcessId`], { encoding: 'utf8' });
      pid = Number(output.trim());
    } else {
      pid = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)).map(Number).find(p => {
        try { return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(path.join(dataDir, 'runtime')); } catch { return false; }
      });
    }
    assert.ok(pid > 0);
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 30 && (await api('/api/me', undefined, s.cookie)).status !== 401; i++) await sleep(50);
    assert.equal((await api('/api/me', undefined, s.cookie)).status, 401);
    const records = (await api('/api/teacher/records', undefined, t.cookie)).json.records;
    assert.equal(records.length, 1);
    assert.equal(records[0].attemptId, start.json.state.score.attemptId);
    assert.equal(records[0].endReason, 'kernel_failure');
    assert.equal(records[0].score.total, 0);
    const next = await login();
    assert.equal(next.json.state.score.active, false);
    assert.equal(next.json.state.sim_time, 0);
  });
});
