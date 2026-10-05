const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  ensureDir,
  hashId,
  readJson,
  writeJsonAtomic,
} = require('./storage');
const { DEFAULT_MODEL_ID, modelSpec } = require('./models');

const HISTORY_LIMIT = 1800;
const MAX_WAITING_COMMANDS = 64;
// 历史字段改为按模型取（见 server/models.js）。
// tank 的取值与改造前完全一致，顺序也不变。
const HISTORY_FIELDS = modelSpec(DEFAULT_MODEL_ID).historyFields;

class EngineSession extends EventEmitter {
  constructor(options) {
    super();
    this.studentId = String(options.studentId);
    this.classId = String(options.classId || '');
    this.sessionKey = String(options.sessionKey || this.studentId);
    this.name = String(options.name || '');
    this.ownerRole = options.ownerRole === 'teacher' ? 'teacher' : 'student';
    this.className = String(options.className || '');
    this.modelId = String(options.modelId || DEFAULT_MODEL_ID);
    this.historyFields = Array.isArray(options.historyFields)
      ? options.historyFields
      : modelSpec(this.modelId).historyFields;
    this.enginePath = options.enginePath;
    this.engineArgs = options.engineArgs;
    this.dataDir = options.dataDir;
    this.stateDir = options.stateDir;
    this.historyDir = options.historyDir;
    this.stateFile = path.join(options.stateDir, `${hashId(this.sessionKey)}.bin`);
    this.historyFile = path.join(options.historyDir, `${hashId(this.sessionKey)}.json`);
    if (options.stateFile) this.stateFile = path.resolve(String(options.stateFile));
    if (options.historyFile) this.historyFile = path.resolve(String(options.historyFile));
    this.child = null;
    this.stdoutBuffer = '';
    this.pending = [];
    this.inflight = null;
    this.stopping = false;
    this.exited = false;
    this.failure = null;
    this.stopPromise = null;
    this.lastState = null;
    this.lastSeen = Date.now();
    this.closed = false;
    this.history = readJson(this.historyFile, {});
    for (const key of this.historyFields) {
      if (!Array.isArray(this.history[key])) this.history[key] = [];
      if (this.history[key].length > HISTORY_LIMIT) {
        this.history[key] = this.history[key].slice(-HISTORY_LIMIT);
      }
    }
    const lastHistoryTime = Number(this.history.t[this.history.t.length - 1]);
    this.historyClock = {
      offset: 0,
      lastRawT: null,
      lastDisplayT: Number.isFinite(lastHistoryTime) ? lastHistoryTime : null,
    };
    this.historyWrites = 0;
    ensureDir(this.stateDir);
    ensureDir(this.historyDir);
  }

  get summary() {
    const s = this.lastState || {};
    const score = s.score || {};
    const loops = Array.isArray(s.loops) ? s.loops : [];
    const cascades = Array.isArray(s.cascades) ? s.cascades : [];
    const loopParams = loops.map((loop) => ({
      pv: Number(loop.pv || 0),
      mv: Number(loop.mv || 0),
      enabled: loop.enabled !== false,
      manual: !!loop.manual,
      action: Number(loop.action || 1),
      sp: Number(loop.sp || 0),
      kp: Number(loop.kp || 0),
      ti: Number(loop.ti ?? -1),
      td: Number(loop.td || 0),
      out: Number(loop.out || 0),
      manualOut: Number(loop.manualOut || 0),
      pvValue: Number(loop.pvValue || 0),
    }));
    const cascadeParams = cascades.map((cascade) => ({
      mv: Number(cascade.mv || 0),
      outer: Number(cascade.outer || 0),
      inner: Number(cascade.inner || 0),
      enabled: cascade.enabled !== false,
      outerManual: !!cascade.outerManual,
      innerManual: !!cascade.innerManual,
      outerAction: Number(cascade.outerAction || 1),
      innerAction: Number(cascade.innerAction || 1),
      outerSp: Number(cascade.outerSp || 0),
      outerKp: Number(cascade.outerKp || 0),
      outerTi: Number(cascade.outerTi ?? -1),
      outerTd: Number(cascade.outerTd || 0),
      innerKp: Number(cascade.innerKp || 0),
      innerTi: Number(cascade.innerTi ?? -1),
      innerTd: Number(cascade.innerTd || 0),
      outerOut: Number(cascade.outerOut || 0),
      innerOut: Number(cascade.innerOut || 0),
      outerPvValue: Number(cascade.outerPvValue || 0),
      innerPvValue: Number(cascade.innerPvValue || 0),
    }));
    // 位号快照交给 ModelSpec 的 summaryTagKeys 决定：教师端看板不再写死液位位号。
    const tags = {};
    for (const key of modelSpec(this.modelId).summaryTagKeys || []) {
      tags[key] = Number(s[key] || 0);
    }
    return {
      modelId: this.modelId,
      tags,
      studentId: this.studentId,
      classId: this.classId,
      name: this.name,
      className: this.className,
      ownerRole: this.ownerRole,
      online: !this.closed && !this.stopping,
      lastSeen: this.lastSeen,
      running: !!s.running,
      paused: !!s.paused,
      mode: Number(s.mode || 0),
      h1: Number(s.h1 || 0),
      h2: Number(s.h2 || 0),
      h3: Number(s.h3 || 0),
      simTime: Number(s.sim_time || 0),
      bias: !!s.bias,
      pump: Number(s.pump || 0),
      pumpCmd: Number(s.pumpCmd || 0),
      fv101: Number(s.fv101 || 0),
      fv102: Number(s.fv102 || 0),
      fv103: Number(s.fv103 || 0),
      fv104: Number(s.fv104 || 0),
      fv101cmd: Number(s.fv101cmd || 0),
      fv102cmd: Number(s.fv102cmd || 0),
      fv103cmd: Number(s.fv103cmd || 0),
      fv104cmd: Number(s.fv104cmd || 0),
      sp1: Number(s.sp1 || 0),
      sp2: Number(s.sp2 || 0),
      sp3: Number(s.sp3 || 0),
      loops: loops.length,
      cascades: cascades.length,
      loopParams,
      cascadeParams,
      scoreMode: Number(score.mode || 0),
      scoreTime: Number(score.sessionT || 0),
      scoreFinished: !!score.finished,
      scoreTotal: Number(score.total || 0),
      attemptId: score.attemptId || null,
      configRevision: score.configRevision ?? null,
      endReason: score.endReason || null,
      control: Number(score.control || 0),
      safety: Number(score.safety || 0),
      benefit: Number(score.benefit || 0),
      operation: Number(score.operation || 0),
      target: Number(score.target || 0),
      safetyDeduction: Number(score.safetyDeduction || 0),
      durationS: Number(score.durationS || 0),
    };
  }

  start() {
    if (this.child) return this.startPromise;
    if (this.exited) return Promise.reject(new Error('engine session has exited'));
    const args = this.engineArgs || ['--state-file', this.stateFile,
      ...(this.ownerRole === 'student' ? ['--no-pid-bias'] : [])];
    this.child = spawn(this.enginePath, args, {
      cwd: path.dirname(this.enginePath),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) this.emit('log', text);
    });
    this.child.stdin.on('error', (err) => this._abort(err));
    this.child.on('error', (err) => this._abort(err));
    this.child.on('exit', (code, signal) => this._fail(new Error(`engine exited ${code ?? signal}`)));
    this.child.on('close', () => this._fail(new Error('engine closed')));
    this.closed = false;
    this.startPromise = this.send('STATE');
    return this.startPromise;
  }

  send(command, timeoutMs = 8000) {
    return this._enqueue(command, timeoutMs, false);
  }

  _enqueue(command, timeoutMs, stoppingCommand) {
    if (this.closed || this.failure || !this.child || (this.stopping && !stoppingCommand)) {
      return Promise.reject(this.failure || Object.assign(new Error('内核会话正在停止或已退出'), { code: 'ENGINE_CLOSED', statusCode: 503 }));
    }
    if (!/^[A-Z_]+(?: (?:[A-Za-z_]+|[0-9eE+\-.]+))*$/.test(command)) {
      return Promise.reject(new Error('invalid command'));
    }
    if (this.pending.length >= MAX_WAITING_COMMANDS) {
      return Promise.reject(Object.assign(new Error('内核等待队列已满（64）'), { code: 'ENGINE_BUSY', statusCode: 503 }));
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ command, timeoutMs, resolve, reject, timer: null });
      this._dispatch();
    });
  }

  _dispatch() {
    if (this.inflight || this.failure || this.closed || !this.child) return;
    const item = this.pending.shift();
    if (!item) return;
    this.inflight = item;
    item.timer = setTimeout(() => this._abort(Object.assign(new Error(`engine timeout: ${item.command}`), {
      code: 'ENGINE_TIMEOUT', statusCode: 503,
    })), item.timeoutMs);
    this.child.stdin.write(`${item.command}\n`, 'utf8', err => { if (err) this._abort(err); });
  }

  _rejectAll(err) {
    const items = this.inflight ? [this.inflight, ...this.pending] : this.pending;
    this.inflight = null;
    this.pending = [];
    for (const item of items) { clearTimeout(item.timer); item.reject(err); }
  }

  _abort(err) {
    if (this.exited || this.failure) return;
    this.failure = Object.assign(err, { code: err.code || 'ENGINE_FAILURE', statusCode: 503 });
    this.stopping = true;
    this._rejectAll(this.failure);
    this.stdoutBuffer = '';
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }

  tick(run) {
    return this.send(`TICK ${run ? 1 : 0}`, 4500);
  }

  appendHistory(state) {
    const rawT = Number(state.sim_time || 0);
    const clock = this.historyClock;
    if (!Number.isFinite(clock.lastRawT)) {
      if (Number.isFinite(clock.lastDisplayT) && rawT < clock.lastDisplayT) {
        clock.offset = clock.lastDisplayT - rawT;
      }
    } else if (rawT + 1e-9 < clock.lastRawT) {
      clock.offset = Math.max(clock.offset, (Number(clock.lastDisplayT) || rawT) + 0.1 - rawT);
    }
    const t = rawT + clock.offset;
    clock.lastRawT = rawT;
    clock.lastDisplayT = t;
    const previous = this.history.t[this.history.t.length - 1];
    // 通道取值一律按本模型的历史字段表来取：模型差异只在 ModelSpec 数据里，
    // 这里不再写死液位的位号（见《换热器融合方案设计 v1.1》第 7.3 节）。
    const values = { t };
    for (const key of this.historyFields) {
      if (key === 't') continue;
      values[key] = Number(state[key] || 0);
    }
    for (const key of this.historyFields) {
      const arr = this.history[key];
      if (t === previous && arr.length > 0) arr[arr.length - 1] = values[key];
      else arr.push(values[key]);
      if (arr.length > HISTORY_LIMIT) arr.splice(0, arr.length - HISTORY_LIMIT);
    }
    this.historyWrites++;
    if (this.historyWrites % 30 === 0) this.saveHistory();
  }

  saveHistory() {
    writeJsonAtomic(this.historyFile, this.history);
  }

  clearHistory() {
    this.history = {};
    for (const key of this.historyFields) this.history[key] = [];
    const rawT = Number(this.lastState?.sim_time || 0);
    this.historyClock = {
      offset: Number.isFinite(rawT) ? -rawT : 0,
      lastRawT: Number.isFinite(rawT) ? rawT : null,
      lastDisplayT: 0,
    };
    this.saveHistory();
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    if (!this.child || this.exited) return Promise.resolve();
    this.stopping = true;
    this.stopPromise = new Promise(resolve => this.once('closed', resolve));
    this.killTimer = setTimeout(() => {
      // closed reflects actual process exit, not the intent to stop.
      if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    }, 1200);
    this.killTimer.unref?.();
    (async () => {
      try {
        await this._enqueue('SAVE', 1000, true);
        await this._enqueue('QUIT', 1000, true);
      } catch (err) { this._abort(err); }
    })();
    this.saveHistory();
    return this.stopPromise;
  }

  _onStdout(chunk) {
    if (this.failure || this.exited) return;
    this.stdoutBuffer += String(chunk);
    let index;
    while ((index = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this._abort(Object.assign(new Error('bad engine JSON'), { code: 'ENGINE_PROTOCOL' }));
        return;
      }
      const item = this.inflight;
      this.inflight = null;
      if (!item || !['state', 'error'].includes(message.type)) {
        if (item) { clearTimeout(item.timer); item.reject(new Error('unexpected engine reply')); }
        this._abort(Object.assign(new Error('unexpected engine reply'), { code: 'ENGINE_PROTOCOL' }));
        return;
      }
      clearTimeout(item.timer);
      if (item) {
        if (message.type === 'error') {
          const error = new Error(message.message || 'engine error');
          if (message.code) error.code = String(message.code);
          item.reject(error);
        }
        else item.resolve(message);
      }
      if (message.type === 'state') {
        this.lastState = message;
        this.lastSeen = Date.now();
        this.emit('state', message);
      }
    }
    this._dispatch();
  }

  _fail(err) {
    if (this.exited) return;
    this.exited = true;
    this.closed = true;
    clearTimeout(this.killTimer);
    this.child = null;
    this._rejectAll(this.failure || Object.assign(err, { code: 'ENGINE_EXITED', statusCode: 503 }));
    this.emit('closed', this.failure || err);
  }
}

module.exports = { EngineSession, HISTORY_FIELDS, HISTORY_LIMIT, MAX_WAITING_COMMANDS };
