'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function removeTestDir(dir) {
  if (!path.resolve(dir).startsWith(path.join(ROOT, '.test-data-'))) throw new Error('unsafe test cleanup');
  fs.rmSync(dir, { recursive: true, force: true });
}
async function withServer(run, extraEnv = {}, initializeData) {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const dataDir = fs.mkdtempSync(path.join(ROOT, '.test-data-core-'));
  if (initializeData) initializeData(dataDir);
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), YUN_DATA_DIR: dataDir,
      YUN_TEACHER_CODE: 'TEST_ONLY_TEACHER', YUN_CLASS_CODE: 'CORE26', ...extraEnv },
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const cookies = new Set();
  async function api(url, body, cookie, headers = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch {}
    const token = (response.headers.get('set-cookie') || '').split(';')[0];
    if (token.length > 20) cookies.add(token);
    return { status: response.status, json, text, cookie: token, headers: response.headers };
  }
  const cmd = (cookie, command) => api('/api/command', { cmd: command }, cookie);
  const teacher = model => api('/api/login', { role: 'teacher', teacherCode: 'TEST_ONLY_TEACHER', model: model || 'tank' });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(logs);
      try { if ((await api('/api/health')).status === 200) { ready = true; break; } } catch {}
      await sleep(50);
    }
    if (!ready) throw new Error('server startup failed: ' + logs);
    await run({ api, cmd, teacher, port, dataDir, child, logs: () => logs });
  } finally {
    for (const cookie of cookies) { try { await api('/api/logout', {}, cookie); } catch {} }
    await sleep(150);
    const exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
    if (child.exitCode === null) child.kill();
    await exited;
    await sleep(100);
    removeTestDir(dataDir);
  }
}
module.exports = { ROOT, withServer, sleep, removeTestDir };
