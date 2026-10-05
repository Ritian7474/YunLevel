'use strict';
/*
 * YunLevel end-to-end smoke test.
 *
 * Purpose: regression net for the heat-exchanger fusion work. It boots an
 * isolated server (temp data dir + spare port) and walks the full teacher +
 * student chain, so the tank track can be proven intact at every stage.
 *
 * Engine contract this script locks in:
 *   - state.loops[] carries kp / ti / td / action(+-1) / out, Ti keeps its value
 *     verbatim and Ki is derived in the UI as 1/Ti
 *   - SET_SP takes a 0-based PV index (0..2 -> LI101..LI103)
 *   - history is an object of equal-length channels (16 of them), not an array
 *   - snapshots are allowed in cold state or while paused; only running &
 *     not-paused is rejected
 *
 * Usage:
 *   node scripts/smoke-e2e.js
 *   set SMOKE_PORT=8098 && node scripts/smoke-e2e.js
 *
 * Exit code 0 = all checks passed.
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { removeTestDir } = require('./test-support');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SMOKE_PORT || 8097);
const BASE = 'http://127.0.0.1:' + PORT;
const TEACHER_CODE = 'TEST_TEACHER_CODE';
const CLASS_CODE = 'SMOKE26';
const STUDENT_ID = 'S9001';
const STUDENT_NAME = 'SmokeTest';
const HISTORY_CHANNELS = 16;
const KEEP_DATA = process.env.SMOKE_KEEP === '1';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  PASS  ' + name);
    return true;
  }
  failed++;
  failures.push(name + (detail ? ' :: ' + detail : ''));
  console.log('  FAIL  ' + name + (detail ? ' :: ' + detail : ''));
  return false;
}

function section(title) {
  console.log('');
  console.log('== ' + title + ' ==');
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

const state = { teacher: '', student: '', classId: '', hxTeacher: '', hxStudent: '' };
const loggedInCookies = new Set();

async function api(urlPath, opts) {
  opts = opts || {};
  const headers = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  let body;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(BASE + urlPath, { method: opts.method || 'GET', headers: headers, body: body });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (err) { json = null; }
  let cookie = '';
  if (typeof res.headers.getSetCookie === 'function') {
    const list = res.headers.getSetCookie();
    if (list.length) cookie = list.map(function (c) { return c.split(';')[0]; }).join('; ');
  }
  if (urlPath === '/api/login' && res.status === 200 && cookie) loggedInCookies.add(cookie);
  return { status: res.status, text: text, json: json, cookie: cookie, headers: res.headers };
}

async function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await api('/api/health');
      if (res.status === 200 && res.json && res.json.ok) return res.json;
      last = res.status + ' ' + res.text.slice(0, 120);
    } catch (err) {
      last = err.message;
    }
    await sleep(200);
  }
  throw new Error('server did not become healthy: ' + last);
}

function enginePids(dataDir) {
  if (process.platform === 'win32') {
    const escaped = dataDir.replace(/'/g, "''");
    const out = execFileSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'YunEngine.exe','HxEngine.exe' -and $_.CommandLine -like '*${escaped}*' } | Select-Object -ExpandProperty ProcessId`],
      { encoding: 'utf8', windowsHide: true });
    return out.split(/\s+/).filter(Boolean).map(Number);
  }
  if (process.platform === 'linux') return fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)).map(Number).filter(pid => {
    try {
      const exe = fs.readlinkSync(`/proc/${pid}/exe`);
      return ['YunEngine', 'HxEngine'].includes(path.basename(exe)) && fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(dataDir);
    } catch { return false; }
  });
  throw new Error('Process cleanup verification supports Windows (PowerShell 7) and Linux.');
}

function cmdAs(cookie, cmdText) {
  return api('/api/command', { method: 'POST', cookie: cookie, body: { cmd: cmdText } });
}

function cmd(cmdText) {
  return cmdAs(state.student, cmdText);
}

function cmdHx(cmdText) {
  return cmdAs(state.hxStudent, cmdText);
}

async function advanceStudent(model, count) {
  for (let i = 0; i < count; i++) {
    const result = await api('/api/teacher/command/' + state.classId + '/' + STUDENT_ID, {
      method: 'POST', cookie: state.teacher, body: { cmd: 'TICK 1', model },
    });
    if (result.status !== 200) throw new Error('teacher advance failed: ' + result.text);
  }
}

function st(res) {
  return res && res.json && res.json.state ? res.json.state : null;
}

async function main() {
  // 数据目录放在仓库内的 .test-data-smoke/，方便事后取证与归档（不写系统临时目录）。
  const testRoot = path.join(ROOT, '.test-data-smoke');
  const dataDir = KEEP_DATA
    ? path.join(testRoot, 'keep')
    : (fs.mkdirSync(testRoot, { recursive: true }), fs.mkdtempSync(path.join(testRoot, 'run-')));
  if (KEEP_DATA) fs.mkdirSync(dataDir, { recursive: true });
  console.log('port      : ' + PORT);
  console.log('data dir  : ' + dataDir);

  const before = enginePids(dataDir);
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      YUN_DATA_DIR: dataDir,
      YUN_TEACHER_CODE: TEACHER_CODE,
      YUN_CLASS_CODE: CLASS_CODE,
      YUN_MAX_SESSIONS: '8',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', function (d) { process.stdout.write('[srv] ' + d); });
  child.stderr.on('data', function (d) { process.stderr.write('[srv] ' + d); });

  let bootOk = false;
  try {
    const health = await waitHealth(25000);
    bootOk = true;
    section('boot');
    check('GET /api/health ok', health.ok === true);
    check('engine is YunEngine.exe', String(health.engine || '').indexOf('YunEngine') >= 0, String(health.engine));

    section('teacher login + roster');
    const tLogin = await api('/api/login', { method: 'POST', body: { role: 'teacher', teacherCode: TEACHER_CODE } });
    check('teacher login 200', tLogin.status === 200, tLogin.status + ' ' + tLogin.text.slice(0, 160));
    state.teacher = tLogin.cookie;
    check('teacher token issued', !!state.teacher);
    check('teacher state present', !!(tLogin.json && tLogin.json.state && typeof tLogin.json.state.sim_time !== 'undefined'));

    const classes = await api('/api/teacher/classes', { cookie: state.teacher });
    check('class list 200', classes.status === 200 && classes.json && Array.isArray(classes.json.classes), classes.text.slice(0, 160));
    const classList = (classes.json && classes.json.classes) || [];
    check('fresh data dir seeds exactly one class', classList.length === 1, 'count ' + classList.length);
    const seeded = classList.filter(function (c) { return c.code === CLASS_CODE; });
    check('seeded class uses configured code', seeded.length === 1);
    state.classId = seeded.length ? seeded[0].id : '';

    const spare = await api('/api/teacher/classes', {
      method: 'POST', cookie: state.teacher, body: { name: 'Smoke Spare', code: CLASS_CODE + 'X' },
    });
    check('create class 200', spare.status === 200, spare.status + ' ' + spare.text.slice(0, 160));
    const spareId = spare.json && spare.json.class ? spare.json.class.id : '';
    check('class id returned', !!spareId);

    const dupeClass = await api('/api/teacher/classes', {
      method: 'POST', cookie: state.teacher, body: { name: 'Smoke Dupe', code: CLASS_CODE + 'X' },
    });
    check('duplicate class code rejected', dupeClass.status === 400, 'status ' + dupeClass.status);

    const dropped = await api('/api/teacher/classes/' + spareId, { method: 'DELETE', cookie: state.teacher });
    check('delete class 200', dropped.status === 200, dropped.text.slice(0, 160));

    const added = await api('/api/teacher/classes/' + state.classId + '/students', {
      method: 'POST', cookie: state.teacher, body: { studentId: STUDENT_ID, name: STUDENT_NAME },
    });
    check('add student 200', added.status === 200, added.status + ' ' + added.text.slice(0, 160));

    const dupeStudent = await api('/api/teacher/classes/' + state.classId + '/students', {
      method: 'POST', cookie: state.teacher, body: { studentId: STUDENT_ID, name: STUDENT_NAME },
    });
    check('duplicate student rejected', dupeStudent.status === 400, 'status ' + dupeStudent.status);

    const opened = await api('/api/teacher/settings', {
      method: 'POST', cookie: state.teacher, body: { allowStudentUpload: true },
    });
    check('teacher opens student upload', opened.status === 200 && opened.json && opened.json.settings.allowStudentUpload === true, opened.text.slice(0, 160));

    section('student login + cold start');
    const sLogin = await api('/api/login', {
      method: 'POST', body: { role: 'student', classCode: CLASS_CODE, studentId: STUDENT_ID, name: STUDENT_NAME },
    });
    check('student login 200', sLogin.status === 200, sLogin.status + ' ' + sLogin.text.slice(0, 160));
    state.student = sLogin.cookie;
    check('student token issued', !!state.student);

    const badLogin = await api('/api/login', {
      method: 'POST', body: { role: 'student', classCode: CLASS_CODE, studentId: STUDENT_ID, name: 'Wrong Name' },
    });
    check('wrong name rejected (403)', badLogin.status === 403, 'status ' + badLogin.status);

    let current = await api('/api/state', { cookie: state.student });
    check('GET /api/state 200', current.status === 200, 'status ' + current.status);
    check('cold state: not running', !!(current.json && current.json.state) && current.json.running === false, 'body ' + current.text.slice(0, 120));
    check('cold state: simTime 0', !!(current.json && current.json.state) && Number(current.json.state.sim_time) === 0, 'simTime ' + (current.json && current.json.state && current.json.state.sim_time));
    check('cold state: no loops', current.json && current.json.loops === 0, 'loops ' + (current.json && current.json.loops));
    const cold = st(current) || {};
    const coldLevels = [Number(cold.h1), Number(cold.h2), Number(cold.h3)];

    section('loop build + PID edit');
    const add1 = await cmd('LOOP_ADD 2 2');
    check('LOOP_ADD 2 2 accepted', add1.status === 200, add1.text.slice(0, 200));
    check('one loop present', !!(st(add1) && st(add1).nLoop === 1), JSON.stringify(st(add1) && st(add1).nLoop));

    const dup = await cmd('LOOP_ADD 2 2');
    check('duplicate loop rejected', dup.status === 400 && dup.json && dup.json.code === 'LOOP_DUPLICATE', dup.text.slice(0, 160));

    const conflict = await cmd('LOOP_ADD 1 2');
    check('same valve other PV rejected', conflict.status === 400 && conflict.json && conflict.json.code === 'LOOP_MV_CONFLICT', conflict.text.slice(0, 160));

    const outOfRange = await cmd('LOOP_ADD 3 1');
    check('PV index out of range rejected', outOfRange.status === 400 && outOfRange.json && outOfRange.json.code === 'LOOP_INVALID_SELECTION', outOfRange.text.slice(0, 160));

    const badTi = await cmd('SET_PID loop 0 0.5 0 60 1 0 0');
    check('Ti=0 rejected', badTi.status === 400 && badTi.json && badTi.json.code === 'PID_TI_INVALID', badTi.text.slice(0, 160));

    const setPid = await cmd('SET_PID loop 0 0.5 60 0 1 0 0');
    check('SET_PID accepted', setPid.status === 200, setPid.text.slice(0, 160));
    const loop0 = st(setPid) ? st(setPid).loops[0] : null;
    check('Ti stored verbatim', !!loop0 && Math.abs(Number(loop0.ti) - 60) < 1e-6, JSON.stringify(loop0 && loop0.ti));
    check('Ki derives to 1/Ti', !!loop0 && Math.abs(1 / Number(loop0.ti) - 1 / 60) < 1e-6, String(loop0 && 1 / Number(loop0.ti)));
    check('Kp stored verbatim', !!loop0 && Math.abs(Number(loop0.kp) - 0.5) < 1e-9, String(loop0 && loop0.kp));
    check('forward action stored as +1', !!loop0 && Number(loop0.action) === 1);

    const rev = await cmd('SET_PID loop 0 0.5 60 0 -1 0 0');
    check('reverse action stored as -1', !!(st(rev) && st(rev).loops[0]) && Number(st(rev).loops[0].action) === -1, JSON.stringify(st(rev) && st(rev).loops[0] && st(rev).loops[0].action));

    const manual = await cmd('SET_PID loop 0 0.5 60 0 -1 1 33');
    check('manual output applied', !!(st(manual) && st(manual).loops[0]) && Math.abs(Number(st(manual).loops[0].manualOut) - 33) < 1e-6, JSON.stringify(st(manual) && st(manual).loops[0] && st(manual).loops[0].manualOut));
    await cmd('SET_PID loop 0 0.5 60 0 1 0 0');

    section('run + history');
    const pump = await cmd('SET_PUMP 100');
    check('SET_PUMP accepted', pump.status === 200, pump.text.slice(0, 160));

    const feed = await cmd('SET_VALVE 0 100');
    check('SET_VALVE opens FV101', feed.status === 200 && Math.abs(Number(st(feed).fv101cmd) - 100) < 1e-6, 'fv101cmd ' + (st(feed) && st(feed).fv101cmd));

    const start = await cmd('START');
    check('START accepted', start.status === 200 && st(start).running === true, start.text.slice(0, 160));

    const modeRun = await cmd('SET_MODE 1');
    check('mode switch blocked while running', modeRun.status === 400 && modeRun.json && modeRun.json.code === 'MODE_RUNNING', modeRun.text.slice(0, 160));

    await advanceStudent('tank', 20);

    const hist = await api('/api/history', { cookie: state.student });
    check('history endpoint 200', hist.status === 200, 'status ' + hist.status);
    const channels = hist.json && hist.json.history ? hist.json.history : null;
    const tArr = channels && Array.isArray(channels.t) ? channels.t : [];
    check('history samples recorded', tArr.length > 0, 'samples ' + tArr.length);
    check('history carries ' + HISTORY_CHANNELS + ' channels', !!channels && Object.keys(channels).length === HISTORY_CHANNELS, 'channels ' + (channels && Object.keys(channels).length));
    const widths = channels ? Object.keys(channels).map(function (k) { return channels[k].length; }) : [];
    check('history channels aligned', widths.length > 0 && widths.every(function (w) { return w === widths[0]; }), 'widths ' + JSON.stringify(widths));

    current = await api('/api/state', { cookie: state.student });
    const run = st(current) || {};
    const moved = Math.abs(Number(run.h1) - coldLevels[0]) + Math.abs(Number(run.h2) - coldLevels[1]) + Math.abs(Number(run.h3) - coldLevels[2]);
    check('tank levels moved with pump on', moved > 1e-6, 'cold ' + JSON.stringify(coldLevels) + ' now ' + JSON.stringify([run.h1, run.h2, run.h3]));
    check('levels reported as percent 0..100', [run.h1, run.h2, run.h3].every(function (v) { return Number(v) >= 0 && Number(v) <= 100; }), JSON.stringify([run.h1, run.h2, run.h3]));
    const runLoop = run.loops ? run.loops[0] : null;
    check('loop output finite', !!runLoop && Number.isFinite(Number(runLoop.out)), String(runLoop && runLoop.out));
    check('loop output within 0..100', !!runLoop && Number(runLoop.out) >= 0 && Number(runLoop.out) <= 100, String(runLoop && runLoop.out));

    const paused = await cmd('PAUSE');
    check('PAUSE toggles', st(paused) && st(paused).paused === true, paused.text.slice(0, 160));

    section('project save / restore / export');
    const forbiddenSp = await cmd('SET_SP 2 45');
    check('student cannot change teacher SP', forbiddenSp.status === 403, forbiddenSp.text);
    await api('/api/teacher/settings', { method: 'POST', cookie: state.teacher, body: { scoreConfig: { sp3: 45 } } });
    const setSp = await cmd('STATE');
    check('teacher SP applied', setSp.status === 200, setSp.text.slice(0, 160));
    check('SET_SP writes the indexed tank (0-based)', !!st(setSp) && Math.abs(Number(st(setSp).sp3) - 45) < 1e-6, 'sp3 ' + (st(setSp) && st(setSp).sp3));

    const cur = await api('/api/current/save', { method: 'POST', cookie: state.student, body: {} });
    check('current save 200', cur.status === 200 && cur.json.ok === true, cur.text.slice(0, 200));
    check('current snapshot has meta', !!(cur.json.current && cur.json.current.savedAt), JSON.stringify(cur.json.current).slice(0, 160));

    const submit = await api('/api/student/submit', { method: 'POST', cookie: state.student, body: { assets: {}, slot: 2 } });
    check('cloud submit 200', submit.status === 200 && submit.json.ok === true, submit.text.slice(0, 200));
    check('submission meta returned', !!(submit.json.project && submit.json.project.savedAt), JSON.stringify(submit.json.project).slice(0, 160));

    const cloudStatus = await api('/api/student/cloud-status', { cookie: state.student });
    check('cloud status lists slots', cloudStatus.status === 200 && Array.isArray(cloudStatus.json.slots), cloudStatus.text.slice(0, 200));

    const restore = await api('/api/student/restore', { method: 'POST', cookie: state.student, body: { slot: 2 } });
    check('cloud restore 200', restore.status === 200, restore.text.slice(0, 200));
    check('restored state is idle', !!(restore.json.state) && restore.json.state.running === false, JSON.stringify(restore.json.state && restore.json.state.running));
    check('restored SP kept', !!(restore.json.state) && Math.abs(Number(restore.json.state.sp3) - 45) < 1e-6, 'sp3 ' + (restore.json.state && restore.json.state.sp3));
    check('restored one loop', !!(restore.json.state) && restore.json.state.nLoop === 1, 'nLoop ' + (restore.json.state && restore.json.state.nLoop));

    const coldSave = await api('/api/current/save', { method: 'POST', cookie: state.student, body: {} });
    check('save accepted in restored idle state', coldSave.status === 200 && coldSave.json.ok === true, coldSave.text.slice(0, 200));
    const runningAgain = await cmd('START');
    check('student restarted for save guard', runningAgain.status === 200 && st(runningAgain).running === true, runningAgain.text.slice(0, 160));
    const runningSave = await api('/api/current/save', { method: 'POST', cookie: state.student, body: {} });
    check('save refused while running and not paused', runningSave.status === 400, 'status ' + runningSave.status);

    const studentExport = await api('/api/current/export', { cookie: state.student });
    check('student export blocked (403)', studentExport.status === 403, 'status ' + studentExport.status);

    section('teacher cockpit');
    const overview = await api('/api/teacher/overview?classId=' + state.classId, { cookie: state.teacher });
    check('overview 200', overview.status === 200, overview.text.slice(0, 200));
    const sessions = overview.json && Array.isArray(overview.json.sessions) ? overview.json.sessions : [];
    const mine = sessions.filter(function (s) { return s.studentId === STUDENT_ID; });
    check('overview contains the student', mine.length === 1, 'found ' + mine.length + ' of ' + sessions.length);
    check('overview reports loop params', !!(mine[0] && mine[0].loopParams), JSON.stringify(mine[0] && mine[0].loopParams));

    const subs = await api('/api/teacher/submissions?classId=' + state.classId, { cookie: state.teacher });
    check('submissions 200', subs.status === 200, subs.text.slice(0, 200));
    check('submissions has a slot', !!(subs.json && Array.isArray(subs.json.projects) && subs.json.projects.length > 0), subs.text.slice(0, 200));

    const load = await api('/api/teacher/load-project', {
      method: 'POST', cookie: state.teacher,
      body: { classId: state.classId, studentId: STUDENT_ID, slot: 2 },
    });
    check('teacher loads student project', load.status === 200 && load.json.ok === true, load.text.slice(0, 200));
    const teacherState = await api('/api/state', { cookie: state.teacher });
    check('teacher engine shows student SP', !!(teacherState.json && teacherState.json.state) && Math.abs(Number(teacherState.json.state.sp3) - 45) < 1e-6, 'sp3 ' + (teacherState.json && teacherState.json.state && teacherState.json.state.sp3));

    const teacherStart = await cmdAs(state.teacher, 'START');
    check('teacher START accepted', teacherStart.status === 200 && st(teacherStart).running === true, teacherStart.text.slice(0, 160));
    const teacherPause = await cmdAs(state.teacher, 'PAUSE');
    check('teacher PAUSE accepted', !!(st(teacherPause) && st(teacherPause).paused === true), teacherPause.text.slice(0, 160));
    const teacherSave = await api('/api/current/save', { method: 'POST', cookie: state.teacher, body: {} });
    check('teacher current save 200', teacherSave.status === 200 && teacherSave.json.ok === true, teacherSave.text.slice(0, 200));
    const teacherExport = await api('/api/current/export', { cookie: state.teacher });
    check('teacher current export 200', teacherExport.status === 200 && teacherExport.text.length > 0, 'status ' + teacherExport.status + ' len ' + teacherExport.text.length);
    const slotExport = await api('/api/teacher/projects/' + state.classId + '/' + STUDENT_ID + '/2/export', { cookie: state.teacher });
    check('teacher slot export 200', slotExport.status === 200 && slotExport.text.length > 0, 'status ' + slotExport.status + ' len ' + slotExport.text.length);

    section('score');
    const notCold = await cmd('SCORE_START 1');
    check('score refused while not cold', notCold.status === 409 && notCold.json && notCold.json.code === 'SCORE_START_NOT_COLD', notCold.text.slice(0, 160));

    const reset = await cmd('RESET');
    check('RESET returns to cold', reset.status === 200 && Number(st(reset).sim_time) === 0, reset.text.slice(0, 160));

    const noMode = await cmd('SCORE_START 1');
    check('score refused without a plan', noMode.status === 409 && noMode.json && noMode.json.code === 'SCORING_DISABLED', noMode.text.slice(0, 160));

    const scoreMode = await api('/api/teacher/settings', { method: 'POST', cookie: state.teacher, body: { scoreSystemOn: true, scoreConfig: { modeTank: 1 } } });
    check('SCORE_MODE 1 accepted', scoreMode.status === 200, scoreMode.text.slice(0, 160));
    const scoreMode2 = await api('/api/teacher/settings', { method: 'POST', cookie: state.teacher, body: { scoreConfig: { modeTank: 2 } } });
    check('SCORE_MODE 2 accepted', scoreMode2.status === 200, scoreMode2.text.slice(0, 160));
    const scoreTank = await api('/api/teacher/settings', { method: 'POST', cookie: state.teacher, body: { scoreConfig: { tankIndex: 1 } } });
    check('SCORE_TANK 1 accepted', scoreTank.status === 200, scoreTank.text.slice(0, 160));
    const scoreStart = await cmd('SCORE_START 1');
    check('SCORE_START accepted in cold state', scoreStart.status === 200, scoreStart.text.slice(0, 160));
    check('score active', !!(st(scoreStart) && st(scoreStart).score) && st(scoreStart).score.active === true, JSON.stringify(st(scoreStart) && st(scoreStart).score));
    check('score plan selected', !!(st(scoreStart) && st(scoreStart).score) && Number(st(scoreStart).score.mode) === 2, JSON.stringify(st(scoreStart) && st(scoreStart).score && st(scoreStart).score.mode));

    await advanceStudent('tank', 10);
    const scored = await cmd('STATE');
    check('score clock runs', !!(st(scored) && st(scored).score) && Number(st(scored).score.sessionT) > 0, JSON.stringify(st(scored) && st(scored).score && st(scored).score.sessionT));

    const record = await api('/api/score-record', { cookie: state.student });
    check('score record endpoint 200', record.status === 200, 'status ' + record.status);
    check('score record is null before finish', record.json && record.json.record === null, JSON.stringify(record.json && record.json.record));

    section('heat exchanger model (plan 3: data isolation)');
    // Closed by default: a student cannot open the hx model before the teacher does.
    const hxClosed = await api('/api/login', {
      method: 'POST', body: { role: 'student', classCode: CLASS_CODE, studentId: STUDENT_ID, name: STUDENT_NAME, model: 'hx' },
    });
    check('hx login blocked while closed (403)', hxClosed.status === 403, 'status ' + hxClosed.status + ' ' + hxClosed.text.slice(0, 120));

    const badModel = await api('/api/login', {
      method: 'POST', body: { role: 'student', classCode: CLASS_CODE, studentId: STUDENT_ID, name: STUDENT_NAME, model: 'nope' },
    });
    check('unknown model rejected (400)', badModel.status === 400, 'status ' + badModel.status);

    const openedHx = await api('/api/teacher/settings', {
      method: 'POST', cookie: state.teacher, body: { openModels: { hx: true } },
    });
    check('teacher opens the hx model', openedHx.status === 200 && openedHx.json.settings.openModels.hx === true, openedHx.text.slice(0, 160));
    check('tank model stays open', openedHx.status === 200 && openedHx.json.settings.openModels.tank === true, openedHx.text.slice(0, 160));

    // 同一学生已在线：新登录应被拒绝，旧会话保留
    const rejectReopen = await api('/api/login', {
      method: 'POST', body: { role: 'student', classCode: CLASS_CODE, studentId: STUDENT_ID, name: STUDENT_NAME, model: 'hx' },
    });
    check('second login rejected while online', rejectReopen.status === 403 && /已登录/.test(rejectReopen.text), rejectReopen.text.slice(0, 120));
    const kept = await api('/api/state', { cookie: state.student });
    check('old session kept after reject', kept.status === 200, 'status ' + kept.status);
    await api('/api/logout', { method: 'POST', cookie: state.student, body: {} });

    const hxLogin = await api('/api/login', {
      method: 'POST', body: { role: 'student', classCode: CLASS_CODE, studentId: STUDENT_ID, name: STUDENT_NAME, model: 'hx' },
    });
    check('hx student login 200 after logout', hxLogin.status === 200, hxLogin.status + ' ' + hxLogin.text.slice(0, 160));
    check('hx login reports the model', hxLogin.json && hxLogin.json.model === 'hx', JSON.stringify(hxLogin.json && hxLogin.json.model));
    state.hxStudent = hxLogin.cookie;

    let hxState = await api('/api/state', { cookie: state.hxStudent });
    check('hx state uses the hx tags', !!(hxState.json && hxState.json.state) && typeof hxState.json.state.ti1104 !== 'undefined' && typeof hxState.json.state.fi1105 !== 'undefined', hxState.text.slice(0, 160));
    check('hx state has no tank tags', !!(hxState.json && hxState.json.state) && hxState.json.state.h1 === undefined);
    check('hx cold state', !!(hxState.json && hxState.json.state) && Number(hxState.json.state.sim_time) === 0 && hxState.json.running === false);
    check('hx has no loops yet', hxState.json && hxState.json.loops === 0);

    const hxCloud = await api('/api/student/cloud-status', { cookie: state.hxStudent });
    check('hx cloud slots are isolated from tank', hxCloud.status === 200 && Array.isArray(hxCloud.json.slots) && hxCloud.json.slots.every(function (slot) { return !slot || slot.savedAt === undefined; }), hxCloud.text.slice(0, 200));

    const hxAdd = await cmdHx('LOOP_ADD 0 0');
    check('hx LOOP_ADD accepted', hxAdd.status === 200 && st(hxAdd).nLoop === 1, hxAdd.text.slice(0, 160));
    const hxDup = await cmdHx('LOOP_ADD 0 0');
    check('hx duplicate loop rejected', hxDup.status === 400 && hxDup.json.code === 'LOOP_DUPLICATE', hxDup.text.slice(0, 160));
    const hxConflict = await cmdHx('LOOP_ADD 1 0');
    check('hx same valve conflict rejected', hxConflict.status === 400 && hxConflict.json.code === 'LOOP_MV_CONFLICT', hxConflict.text.slice(0, 160));
    const hxBadSel = await cmdHx('LOOP_ADD 0 7');
    check('hx bad valve index rejected', hxBadSel.status === 400 && hxBadSel.json.code === 'LOOP_INVALID_SELECTION', hxBadSel.text.slice(0, 160));

    const hxBadTi = await cmdHx('SET_PID loop 0 0.3 0 0 1 0 0');
    check('hx Ti=0 rejected', hxBadTi.status === 400 && hxBadTi.json.code === 'PID_TI_INVALID', hxBadTi.text.slice(0, 160));
    const hxSetPid = await cmdHx('SET_PID loop 0 0.3 20 0 1 0 0');
    check('hx SET_PID accepted', hxSetPid.status === 200, hxSetPid.text.slice(0, 160));
    check('hx Ti stored verbatim', !!(st(hxSetPid) && st(hxSetPid).loops[0]) && Math.abs(Number(st(hxSetPid).loops[0].ti) - 20) < 1e-6, JSON.stringify(st(hxSetPid) && st(hxSetPid).loops[0] && st(hxSetPid).loops[0].ti));

    const hxFuel = await cmdHx('SET_VALVE 1 40');
    check('hx manual fuel valve accepted', hxFuel.status === 200 && Math.abs(Number(st(hxFuel).fv1101) - 40) < 1e-6, hxFuel.text.slice(0, 160));
    const hxOccupied = await cmdHx('SET_VALVE 0 50');
    check('hx loop-owned valve refuses manual write', hxOccupied.status === 400 && hxOccupied.json.code === 'VALVE_LOOP_OCCUPIED', hxOccupied.text.slice(0, 160));

    const hxStart = await cmdHx('START');
    check('hx START accepted', hxStart.status === 200 && st(hxStart).running === true, hxStart.text.slice(0, 160));
    await advanceStudent('hx', 10);
    hxState = await api('/api/state', { cookie: state.hxStudent });
    check('hx simulation advances', Number(hxState.json.state.sim_time) >= 10, 'sim_time ' + (hxState.json.state && hxState.json.state.sim_time));
    check('hx outlet temperature reacts', Number(hxState.json.state.ti1104) > 0, 'ti1104 ' + (hxState.json.state && hxState.json.state.ti1104));

    const hxHist = await api('/api/history', { cookie: state.hxStudent });
    const hxChannels = hxHist.json && hxHist.json.history ? hxHist.json.history : null;
    check('hx history endpoint 200', hxHist.status === 200, 'status ' + hxHist.status);
    check('hx history has 17 channels', !!hxChannels && Object.keys(hxChannels).length === 17, 'channels ' + (hxChannels && Object.keys(hxChannels).length));
    check('hx history samples recorded', !!hxChannels && Array.isArray(hxChannels.t) && hxChannels.t.length > 0, 'samples ' + (hxChannels && hxChannels.t && hxChannels.t.length));

    // 回归：历史通道曾经写死成液位位号，换热器的通道会被记成一串 null。
    const hxOutlet = hxChannels && Array.isArray(hxChannels.ti1104) ? hxChannels.ti1104 : null;
    check('hx history records real outlet temperatures', !!hxOutlet && hxOutlet.length > 0
      && hxOutlet.every(function (v) { return typeof v === 'number' && isFinite(v); })
      && hxOutlet.some(function (v) { return v > 0; }), 'ti1104 ' + JSON.stringify(hxOutlet));
    const hxFlow = hxChannels && Array.isArray(hxChannels.fi1105) ? hxChannels.fi1105 : null;
    check('hx history records real steam flow', !!hxFlow && hxFlow.length > 0
      && hxFlow.every(function (v) { return typeof v === 'number' && isFinite(v); }), 'fi1105 ' + JSON.stringify(hxFlow));

    const tankStill = await api('/api/history', { cookie: state.student });
    check('tank history after logout', tankStill.status === 401, 'status ' + tankStill.status);

    const hxPause = await cmdHx('PAUSE');
    check('hx PAUSE accepted', st(hxPause) && st(hxPause).paused === true, hxPause.text.slice(0, 160));
    const hxSave = await api('/api/current/save', { method: 'POST', cookie: state.hxStudent, body: {} });
    check('hx current save 200', hxSave.status === 200 && hxSave.json.ok === true, hxSave.text.slice(0, 200));
    const hxSubmit = await api('/api/student/submit', { method: 'POST', cookie: state.hxStudent, body: { assets: {}, slot: 2 } });
    check('hx cloud submit 200', hxSubmit.status === 200 && hxSubmit.json.ok === true, hxSubmit.text.slice(0, 200));
    const hxRestore = await api('/api/student/restore', { method: 'POST', cookie: state.hxStudent, body: { slot: 2 } });
    check('hx cloud restore 200', hxRestore.status === 200, hxRestore.text.slice(0, 200));
    check('hx restored idle', !!(hxRestore.json.state) && hxRestore.json.state.running === false);
    check('hx restored one loop', !!(hxRestore.json.state) && hxRestore.json.state.nLoop === 1);

    const hxTeacherLogin = await api('/api/login', { method: 'POST', body: { role: 'teacher', teacherCode: TEACHER_CODE, model: 'hx' } });
    check('hx teacher login 200', hxTeacherLogin.status === 200, hxTeacherLogin.status + ' ' + hxTeacherLogin.text.slice(0, 160));
    state.hxTeacher = hxTeacherLogin.cookie;
    const hxLoad = await api('/api/teacher/load-project', {
      method: 'POST', cookie: state.teacher,
      body: { classId: state.classId, studentId: STUDENT_ID, slot: 2, model: 'hx' },
    });
    check('teacher loads hx student project', hxLoad.status === 200 && hxLoad.json.ok === true, hxLoad.text.slice(0, 200));
    const hxTeacherState = await api('/api/state', { cookie: state.hxTeacher });
    check('hx teacher engine holds the hx state', !!(hxTeacherState.json && hxTeacherState.json.state) && typeof hxTeacherState.json.state.ti1104 !== 'undefined', hxTeacherState.text.slice(0, 160));

    const hxSubs = await api('/api/teacher/submissions?classId=' + state.classId + '&model=hx', { cookie: state.teacher });
    check('teacher hx submissions 200', hxSubs.status === 200 && Array.isArray(hxSubs.json.projects) && hxSubs.json.projects.length > 0, hxSubs.text.slice(0, 200));
    const hxSlotExport = await api('/api/teacher/projects/' + state.classId + '/' + STUDENT_ID + '/2/export?model=hx', { cookie: state.hxTeacher });
    const hxSlotDisposition = decodeURIComponent(String(hxSlotExport.headers.get('content-disposition') || ''));
    check('teacher hx project export carries the model name', hxSlotExport.status === 200
      && hxSlotDisposition.indexOf('换热器') >= 0 && hxSlotExport.text.indexOf('换热器') >= 0, hxSlotDisposition);
    const tankSubs = await api('/api/teacher/submissions?classId=' + state.classId + '&model=tank', { cookie: state.teacher });
    check('tank submissions unaffected', tankSubs.status === 200 && Array.isArray(tankSubs.json.projects) && tankSubs.json.projects.length > 0, tankSubs.text.slice(0, 200));

    const tankAfterHx = await api('/api/state', { cookie: state.student });
    check('tank session logged out before hx', tankAfterHx.status === 401, 'status ' + tankAfterHx.status);

    section('model isolation (plan 3)');
    // 另一学生开 tank 会话，便于总览同时看到 tank/hx（一账号仍只一处登录）
    await api('/api/teacher/classes/' + state.classId + '/students', {
      method: 'POST', cookie: state.teacher, body: { studentId: 'S9003', name: 'TankSide' },
    });
    const sideTank = await api('/api/login', {
      method: 'POST', body: { role: 'student', classCode: CLASS_CODE, studentId: 'S9003', name: 'TankSide', model: 'tank' },
    });
    state.sideTank = sideTank.cookie;

    const tankOverview = await api('/api/teacher/overview?model=tank', { cookie: state.teacher });
    check('tank overview 200', tankOverview.status === 200, tankOverview.text.slice(0, 160));
    check('tank overview only lists tank sessions', !!(tankOverview.json && Array.isArray(tankOverview.json.sessions))
      && tankOverview.json.sessions.length > 0
      && tankOverview.json.sessions.every(function (s) { return s.modelId === 'tank'; }),
      JSON.stringify(((tankOverview.json && tankOverview.json.sessions) || []).map(function (s) { return s.modelId; })));
    const hxOverview = await api('/api/teacher/overview?model=hx', { cookie: state.teacher });
    check('hx overview 200', hxOverview.status === 200, hxOverview.text.slice(0, 160));
    check('hx overview only lists hx sessions', !!(hxOverview.json && Array.isArray(hxOverview.json.sessions))
      && hxOverview.json.sessions.length > 0
      && hxOverview.json.sessions.every(function (s) { return s.modelId === 'hx'; }),
      JSON.stringify(((hxOverview.json && hxOverview.json.sessions) || []).map(function (s) { return s.modelId; })));
    const hxSummary = ((hxOverview.json && hxOverview.json.sessions) || [])[0] || {};
    check('hx summary carries the hx tags', !!hxSummary.tags && typeof hxSummary.tags.ti1104 !== 'undefined' && typeof hxSummary.tags.fi1105 !== 'undefined', JSON.stringify(hxSummary.tags));

    const allOverview = await api('/api/teacher/overview?classId=' + state.classId + '&model=all', { cookie: state.teacher });
    const allOverviewModels = Array.from(new Set((((allOverview.json || {}).sessions) || []).map(function (s) { return s.modelId || 'tank'; }))).sort();
    check('all-model overview returns tank and hx together', allOverview.status === 200
      && allOverviewModels.indexOf('hx') >= 0 && allOverviewModels.indexOf('tank') >= 0,
      JSON.stringify(allOverviewModels));

    const allSubs = await api('/api/teacher/submissions?classId=' + state.classId + '&model=all', { cookie: state.teacher });
    const allSubModels = Array.from(new Set((((allSubs.json || {}).projects) || []).map(function (item) { return item.modelId || ''; }))).sort();
    check('all-model submissions carry their model names', allSubs.status === 200
      && allSubModels.indexOf('hx') >= 0 && allSubModels.indexOf('tank') >= 0,
      JSON.stringify(allSubModels));

    const allProjects = await api('/api/teacher/projects?classId=' + state.classId + '&model=all', { cookie: state.teacher });
    const allProjectModels = Array.from(new Set((((allProjects.json || {}).projects) || []).map(function (item) { return item.modelId || ''; }))).sort();
    check('all-model project list carries their model names', allProjects.status === 200
      && allProjectModels.indexOf('hx') >= 0 && allProjectModels.indexOf('tank') >= 0,
      JSON.stringify(allProjectModels));

    const allRecordsCsv = await api('/api/teacher/export.csv?classId=' + state.classId + '&model=all', { cookie: state.teacher });
    check('score CSV exposes the experiment-model column', allRecordsCsv.status === 200 && allRecordsCsv.text.indexOf('实验模型') >= 0, allRecordsCsv.text.slice(0, 160));

    const hxCloudExport = await api('/api/teacher/cloud-export', {
      method: 'POST', cookie: state.hxTeacher, body: { classId: state.classId, studentIds: [STUDENT_ID], model: 'hx' },
    });
    const hxCloudDisposition = decodeURIComponent(String(hxCloudExport.headers.get('content-disposition') || ''));
    check('hx cloud export status 200', hxCloudExport.status === 200 && hxCloudExport.text.length > 0, 'status ' + hxCloudExport.status + ' len ' + hxCloudExport.text.length);
    check('hx cloud export filename contains the model name', hxCloudDisposition.indexOf('换热器') >= 0, hxCloudDisposition);

    const allCloudExport = await api('/api/teacher/cloud-export', {
      method: 'POST', cookie: state.teacher, body: { classId: state.classId, studentIds: [STUDENT_ID], model: 'all' },
    });
    const allCloudDisposition = decodeURIComponent(String(allCloudExport.headers.get('content-disposition') || ''));
    check('all-model cloud export status 200', allCloudExport.status === 200 && allCloudExport.text.length > 0, 'status ' + allCloudExport.status + ' len ' + allCloudExport.text.length);
    check('all-model cloud export filename contains the combined model label', allCloudDisposition.indexOf('全部模型') >= 0, allCloudDisposition);

    const crossTeacherLogin = await api('/api/login', { method: 'POST', body: { role: 'teacher', teacherCode: TEACHER_CODE, model: 'tank' } });
    check('cross-model teacher login 200', crossTeacherLogin.status === 200 && !!crossTeacherLogin.cookie, crossTeacherLogin.text.slice(0, 160));
    const crossLoad = await api('/api/teacher/load-project', {
      method: 'POST', cookie: state.teacher,
      body: { classId: state.classId, studentId: STUDENT_ID, slot: 2, model: 'hx' },
    });
    check('tank teacher can load an hx project explicitly', crossLoad.status === 200 && crossLoad.json.modelId === 'hx', crossLoad.text.slice(0, 200));
    const crossState = await api('/api/state', { cookie: state.teacher });
    check('teacher auth switches to the loaded hx engine', crossState.status === 200
      && crossState.json.modelId === 'hx' && typeof crossState.json.state.ti1104 !== 'undefined', crossState.text.slice(0, 200));

    // 跨模型误恢复：state.bin 的魔数必须当场拦住，而不是静默变成冷态。
    const models = require(path.join(ROOT, 'server', 'snapshot-store-v2'));
    const magicDir = fs.mkdtempSync(path.join(ROOT, '.test-data-smoke', 'magic-'));
    const tankBin = path.join(magicDir, 'tank.bin');
    const hxBin = path.join(magicDir, 'hx.bin');
    const tankBytes = Buffer.alloc(32); tankBytes.writeUInt32LE(0x594C5631, 0); fs.writeFileSync(tankBin, tankBytes);
    const hxBytes = Buffer.alloc(32); hxBytes.writeUInt32LE(0x594C4858, 0); fs.writeFileSync(hxBin, hxBytes);
    check('state.bin magic reads little-endian', models.stateMagicOf(tankBin) === 0x594C5631 && models.stateMagicOf(hxBin) === 0x594C4858);
    let guardErr = null;
    try { models.assertStateBelongsToModel(hxBin, 'tank'); } catch (err) { guardErr = err; }
    check('hx state refused on the tank model', !!guardErr && guardErr.code === 'MODEL_MISMATCH', guardErr && guardErr.message);
    let guardOk = true;
    try { models.assertStateBelongsToModel(tankBin, 'tank'); } catch (err) { guardOk = false; }
    check('tank state accepted on the tank model', guardOk);
    removeTestDir(magicDir);

    // 名单变更要同时清掉学生在两个模型上的会话。
    const addHx = await api('/api/teacher/classes/' + state.classId + '/students', {
      method: 'POST', cookie: state.teacher, body: { studentId: 'S9002', name: 'HxOnly' },
    });
    check('add second student 200', addHx.status === 200, addHx.text.slice(0, 160));
    const hx2 = await api('/api/login', { method: 'POST', body: { role: 'student', classCode: CLASS_CODE, studentId: 'S9002', name: 'HxOnly', model: 'hx' } });
    check('second student hx login 200', hx2.status === 200, hx2.status + ' ' + hx2.text.slice(0, 160));
    const hx2State = await api('/api/state', { cookie: hx2.cookie });
    check('second student hx session live', hx2State.status === 200, 'status ' + hx2State.status);
    const disabled2 = await api('/api/teacher/classes/' + state.classId + '/students/S9002', { method: 'PUT', cookie: state.teacher, body: { enabled: false } });
    check('disable student 200', disabled2.status === 200, disabled2.text.slice(0, 160));
    const hx2After = await api('/api/state', { cookie: hx2.cookie });
    check('disabling a student also kills the hx session', hx2After.status === 401, 'status ' + hx2After.status);

    section('logout');
    const out = await api('/api/logout', { method: 'POST', cookie: state.student, body: {} });
    check('student logout 200', out.status === 200, 'status ' + out.status);
    const afterLogout = await api('/api/state', { cookie: state.student });
    check('token revoked after logout', afterLogout.status === 401, 'status ' + afterLogout.status);
  } catch (err) {
    failed++;
    failures.push('exception :: ' + (err && err.stack ? err.stack : err));
    console.log('  FAIL  exception :: ' + (err && err.message ? err.message : err));
  } finally {
    for (const cookie of loggedInCookies) {
      try { await api('/api/logout', { method: 'POST', cookie, body: {} }); } catch {}
    }
    await sleep(1500);
    try { child.kill(); } catch (err) { /* ignore */ }
    await sleep(200);
    const leaked = enginePids(dataDir).filter(function (pid) { return before.indexOf(pid) < 0; });
    check('all test kernels exited without leaks', leaked.length === 0, leaked.join(','));
    if (leaked.length) {
      console.log('cleaning leaked engine pids: ' + leaked.join(','));
      for (const pid of leaked) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    if (!KEEP_DATA) {
      removeTestDir(dataDir);
    }
  }

  console.log('');
  console.log('== summary ==');
  console.log('boot   : ' + (bootOk ? 'ok' : 'failed'));
  console.log('passed : ' + passed);
  console.log('failed : ' + failed);
  if (failures.length) {
    console.log('failures:');
    failures.forEach(function (f) { console.log('  - ' + f); });
  }
  process.exit(failed === 0 ? 0 : Math.min(failed, 99));
}

main();
