const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  ensureDir,
  hashId,
  readJson,
  writeJsonAtomic,
} = require('./storage');
const { DEFAULT_MODEL_ID, modelExportSpec, modelSpec } = require('./models');
const { mergeScoreConfig, scoreSystemValue } = require('./score-config');

const PROJECT_SLOTS = 4;
const IMAGE_LIMIT_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const PROJECT_VERSION = 1;

function imageBuffer(value, label) {
  const source = String(value || '').trim();
  if (!source) return null;
  const match = source.match(/^data:image\/png;base64,([A-Za-z0-9+/=\r\n]+)$/i);
  const encoded = match ? match[1] : source;
  let buffer;
  try {
    buffer = Buffer.from(encoded.replace(/\s+/g, ''), 'base64');
  } catch {
    throw Object.assign(new Error(`${label}图片数据无效`), { statusCode: 400 });
  }
  if (!buffer.length) return null;
  if (buffer.length > IMAGE_LIMIT_BYTES) {
    throw Object.assign(new Error(`${label}图片超过 4 MB，请降低曲线画布尺寸后重试`), { statusCode: 400 });
  }
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw Object.assign(new Error(`${label}图片不是有效的 PNG`), { statusCode: 400 });
  }
  return buffer;
}

function copyFile(source, target) {
  if (!source || !target || !fs.existsSync(source)) return false;
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
  return true;
}

function writeFileAtomic(target, data) {
  ensureDir(path.dirname(target));
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, target);
  } catch {
    fs.copyFileSync(tmp, target);
    fs.unlinkSync(tmp);
  }
}

// 读状态文件头 4 字节的魔数。两个模型写的是不同魔数（YLV1 / YLHX），
// 这样跨模型误恢复会被当场拒绝，而不是静默变成冷态。
function stateMagicOf(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) !== 4) return null;
    return buf.readUInt32LE(0);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function nameForMagic(magic) {
  if (magic === modelSpec('tank').stateMagic) return modelSpec('tank').displayName;
  if (magic === modelSpec('hx').stateMagic) return modelSpec('hx').displayName;
  return '';
}

function assertStateBelongsToModel(file, modelId) {
  if (!file || !fs.existsSync(file)) return;
  const magic = stateMagicOf(file);
  if (magic === null) return;
  const expected = modelSpec(modelId).stateMagic;
  if (magic === expected) return;
  const actualName = nameForMagic(magic);
  const shown = actualName || "未知模型";
  throw Object.assign(
    new Error("这份工程属于「" + shown + "」，不能恢复到「" + modelSpec(modelId).displayName + "」上"),
    { statusCode: 400, code: 'MODEL_MISMATCH' },
  );
}

function fileChecksum(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function normalizeSlot(value) {
  const slot = Number(value);
  if (!Number.isInteger(slot) || slot < 1 || slot > PROJECT_SLOTS) {
    throw Object.assign(new Error(`工程编号必须为 1-${PROJECT_SLOTS}`), { statusCode: 400 });
  }
  return slot;
}

function summarizeEngine(engine) {
  const state = engine.lastState || {};
  const score = state.score || {};
  return {
    modelId: engine.modelId || DEFAULT_MODEL_ID,
    classId: engine.classId,
    studentId: engine.studentId,
    name: engine.name,
    className: engine.className,
    ownerRole: engine.ownerRole || 'student',
    simTime: Number(state.sim_time || 0),
    running: !!state.running,
    paused: !!state.paused,
    h1: Number(state.h1 || 0),
    h2: Number(state.h2 || 0),
    h3: Number(state.h3 || 0),
    loops: Array.isArray(state.loops) ? state.loops.length : 0,
    cascades: Array.isArray(state.cascades) ? state.cascades.length : 0,
    scoreMode: Number(score.mode || 0),
    scoreTotal: Number(score.total || 0),
  };
}

function safeHistory(history) {
  return history && typeof history === 'object' && !Array.isArray(history)
    ? history
    : { t: [] };
}

class SnapshotStore {
  constructor(options) {
    this.modelId = String(options.modelId || DEFAULT_MODEL_ID);
    this.settingsFile = options.settingsFile;
    // 多模型时第二个实例只共享全局设置，不各自持有副本。
    this.settingsSource = options.settingsSource || null;
    this.submissionsDir = options.submissionsDir;
    this.teacherBackupsDir = options.teacherBackupsDir;
    ensureDir(this.submissionsDir);
    ensureDir(this.teacherBackupsDir);
    const saved = readJson(this.settingsFile, {});
    const savedModels = saved.openModels && typeof saved.openModels === 'object' ? saved.openModels : {};
    this.settings = {
      allowStudentUpload: saved.allowStudentUpload === true,
      // 默认只开放三级液位；换热器要教师显式打开。
      openModels: {
        tank: savedModels.tank !== false,
        hx: savedModels.hx === true,
      },
      scoreConfig: mergeScoreConfig(null, saved.scoreConfig || {}, true),
      scoreSystemOn: [true,1,'1'].includes(saved.scoreSystemOn),
      scoreConfigRevision: Number.isSafeInteger(saved.scoreConfigRevision) ? saved.scoreConfigRevision : 0,
      updatedAt: saved.updatedAt || null,
    };
  }

  getSettings() {
    if (this.settingsSource) return this.settingsSource.getSettings();
    return JSON.parse(JSON.stringify(this.settings));
  }

  setSettings(patch = {}) {
    if (this.settingsSource) return this.settingsSource.setSettings(patch);
    const hasConfig = Object.prototype.hasOwnProperty.call(patch, 'scoreConfig');
    const hasSwitch = Object.prototype.hasOwnProperty.call(patch, 'scoreSystemOn');
    const nextConfig = hasConfig ? mergeScoreConfig(this.settings.scoreConfig, patch.scoreConfig) : this.settings.scoreConfig;
    const nextSwitch = hasSwitch ? scoreSystemValue(patch.scoreSystemOn) : this.settings.scoreSystemOn;
    if (Object.prototype.hasOwnProperty.call(patch, 'allowStudentUpload')) {
      this.settings.allowStudentUpload = patch.allowStudentUpload === true;
    }
    if (patch.openModels && typeof patch.openModels === 'object') {
      if (Object.prototype.hasOwnProperty.call(patch.openModels, 'tank')) {
        this.settings.openModels.tank = patch.openModels.tank === true;
      }
      if (Object.prototype.hasOwnProperty.call(patch.openModels, 'hx')) {
        this.settings.openModels.hx = patch.openModels.hx === true;
      }
    }
    // 评分细则整包合并保存，避免 POST /api/teacher/settings 静默丢掉 scoreConfig
    if (hasConfig || hasSwitch) {
      this.settings.scoreConfig = nextConfig;
      this.settings.scoreSystemOn = nextSwitch;
      this.settings.scoreConfigRevision += 1;
    }
    this.settings.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.settingsFile, this.settings);
    return this.getSettings();
  }

  submissionDir(classId, studentId) {
    return path.join(this.submissionsDir, hashId(classId), hashId(studentId));
  }

  legacySubmissionFiles(classId, studentId) {
    const dir = this.submissionDir(classId, studentId);
    return {
      dir,
      state: path.join(dir, 'state.bin'),
      history: path.join(dir, 'history.json'),
      meta: path.join(dir, 'meta.json'),
    };
  }

  projectDir(classId, studentId, slot) {
    return path.join(this.submissionDir(classId, studentId), `slot-${normalizeSlot(slot)}`);
  }

  projectFiles(classId, studentId, slot) {
    const dir = this.projectDir(classId, studentId, slot);
    return {
      dir,
      state: path.join(dir, 'state.bin'),
      history: path.join(dir, 'history.json'),
      meta: path.join(dir, 'meta.json'),
    };
  }

  projectAssetFiles(classId, studentId, slot) {
    const files = this.projectFiles(classId, studentId, slot);
    const imagesDir = path.join(files.dir, 'images');
    return {
      ...files,
      params: path.join(files.dir, 'params.json'),
      curveView: path.join(files.dir, 'curve-view.json'),
      imagesDir,
      images: {
        level: path.join(imagesDir, 'level.png'),
        flow: path.join(imagesDir, 'flow.png'),
        valve: path.join(imagesDir, 'valve.png'),
      },
    };
  }

  recoveryDir(classId, studentId) {
    return path.join(this.submissionDir(classId, studentId), 'recovery');
  }

  recoveryFiles(classId, studentId) {
    const dir = this.recoveryDir(classId, studentId);
    return {
      dir,
      state: path.join(dir, 'state.bin'),
      history: path.join(dir, 'history.json'),
      meta: path.join(dir, 'meta.json'),
    };
  }

  currentDir(classId, studentId) {
    return path.join(this.submissionDir(classId, studentId), 'current');
  }

  currentFiles(classId, studentId) {
    const dir = this.currentDir(classId, studentId);
    return {
      dir,
      state: path.join(dir, 'state.bin'),
      history: path.join(dir, 'history.json'),
      meta: path.join(dir, 'meta.json'),
    };
  }

  migrateLegacy(classId, studentId) {
    const legacy = this.legacySubmissionFiles(classId, studentId);
    const slotOne = this.projectFiles(classId, studentId, 1);
    if (fs.existsSync(slotOne.state) || !fs.existsSync(legacy.state)) return false;
    const legacyMeta = readJson(legacy.meta, {});
    ensureDir(slotOne.dir);
    copyFile(legacy.state, slotOne.state);
    copyFile(legacy.history, slotOne.history);
    const meta = {
      ...legacyMeta,
      slot: 1,
      savedAt: legacyMeta.savedAt || legacyMeta.uploadedAt || new Date().toISOString(),
      uploadedAt: legacyMeta.uploadedAt || legacyMeta.savedAt || new Date().toISOString(),
      reason: legacyMeta.reason || 'legacy-migration',
      hasState: true,
      hasHistory: fs.existsSync(slotOne.history),
      checksum: fileChecksum(slotOne.state),
      migratedFrom: 'legacy-single-state',
    };
    writeJsonAtomic(slotOne.meta, meta);
    return true;
  }

  saveProject(engine, slotValue, reason = 'manual', extra = {}) {
    const slot = normalizeSlot(slotValue);
    const files = this.projectAssetFiles(engine.classId, engine.studentId, slot);
    ensureDir(files.dir);
    const now = new Date().toISOString();
    const assetInput = extra && extra.assets && typeof extra.assets === 'object' ? extra.assets : {};
    const imageFlags = { level: false, flow: false, valve: false };
    const imageBuffers = { level: null, flow: null, valve: null };
    // 曲线图片名随模型变化：三级液位是「液位曲线」，换热器是「温度曲线」。
    const imageLabels = modelExportSpec(this.modelId).curveLabels || { level: '曲线', flow: '流量曲线', valve: '开度曲线' };
    const imageInput = assetInput.images && typeof assetInput.images === 'object' ? assetInput.images : {};
    for (const key of Object.keys(imageFlags)) {
      imageBuffers[key] = imageBuffer(imageInput[key], imageLabels[key]);
      imageFlags[key] = !!imageBuffers[key];
    }

    const stateOk = copyFile(engine.stateFile, files.state);
    engine.saveHistory();
    const historyOk = copyFile(engine.historyFile, files.history);
    if (!stateOk) throw new Error('当前仿真状态文件不存在，无法保存工程');
    const paramsPayload = assetInput.params && typeof assetInput.params === 'object'
      ? assetInput.params
      : { generatedAt: now, summary: summarizeEngine(engine), state: engine.lastState || {} };
    writeJsonAtomic(files.params, paramsPayload);

    const hasCurveView = !!(assetInput.curveView && typeof assetInput.curveView === 'object');
    if (hasCurveView) writeJsonAtomic(files.curveView, assetInput.curveView);
    else fs.rmSync(files.curveView, { force: true });

    for (const key of Object.keys(imageFlags)) {
      if (imageBuffers[key]) writeFileAtomic(files.images[key], imageBuffers[key]);
      else fs.rmSync(files.images[key], { force: true });
    }

    const meta = {
      ...summarizeEngine(engine),
      ...extra,
      slot,
      savedAt: now,
      uploadedAt: now,
      reason,
      hasState: true,
      hasHistory: historyOk,
      hasParams: true,
      hasCurveView,
      hasImages: Object.values(imageFlags).every(Boolean),
      imageFlags,
      checksum: fileChecksum(files.state),
    };
    delete meta.assets;
    writeJsonAtomic(files.meta, meta);
    return meta;
  }

  getProject(classId, studentId, slotValue) {
    this.migrateLegacy(classId, studentId);
    const slot = normalizeSlot(slotValue);
    const files = this.projectAssetFiles(classId, studentId, slot);
    const meta = readJson(files.meta, null);
    if (!meta || !fs.existsSync(files.state)) return null;
    return { ...files, meta: { ...meta, slot } };
  }

  listProjects(classId, studentId) {
    this.migrateLegacy(classId, studentId);
    const out = [];
    for (let slot = 1; slot <= PROJECT_SLOTS; slot += 1) {
      const project = this.getProject(classId, studentId, slot);
      out.push(project ? project.meta : { slot, empty: true });
    }
    return out;
  }

  saveCurrent(engine, reason = 'manual', extra = {}) {
    const files = this.currentFiles(engine.classId, engine.studentId);
    ensureDir(files.dir);
    const stateOk = copyFile(engine.stateFile, files.state);
    engine.saveHistory();
    const historyOk = copyFile(engine.historyFile, files.history);
    if (!stateOk) throw new Error('当前仿真状态文件不存在，无法保存');
    const meta = {
      ...summarizeEngine(engine),
      ...extra,
      savedAt: new Date().toISOString(),
      reason,
      hasState: true,
      hasHistory: historyOk,
      checksum: fileChecksum(files.state),
    };
    writeJsonAtomic(files.meta, meta);
    return meta;
  }

  getCurrent(classId, studentId) {
    const files = this.currentFiles(classId, studentId);
    const meta = readJson(files.meta, null);
    if (!meta || !fs.existsSync(files.state)) return null;
    return { ...files, meta };
  }

  saveRecovery(engine, reason = 'forced-exit') {
    const files = this.recoveryFiles(engine.classId, engine.studentId);
    ensureDir(files.dir);
    const stateOk = copyFile(engine.stateFile, files.state);
    engine.saveHistory();
    const historyOk = copyFile(engine.historyFile, files.history);
    if (!stateOk) throw new Error('当前仿真状态文件不存在，无法自动保存');
    const meta = {
      ...summarizeEngine(engine),
      savedAt: new Date().toISOString(),
      reason,
      hasState: true,
      hasHistory: historyOk,
      checksum: fileChecksum(files.state),
      hiddenRecovery: true,
    };
    writeJsonAtomic(files.meta, meta);
    return meta;
  }

  getRecovery(classId, studentId) {
    const files = this.recoveryFiles(classId, studentId);
    const meta = readJson(files.meta, null);
    if (!meta || !fs.existsSync(files.state)) return null;
    return { ...files, meta };
  }

  saveSubmission(engine, reason = 'manual') {
    return this.saveProject(engine, 1, reason);
  }

  getSubmission(classId, studentId) {
    return this.getProject(classId, studentId, 1);
  }

  listSubmissions(classId = '') {
    const out = [];
    if (!fs.existsSync(this.submissionsDir)) return out;
    const filter = String(classId || '');
    for (const classHash of fs.readdirSync(this.submissionsDir)) {
      const classDir = path.join(this.submissionsDir, classHash);
      if (!fs.statSync(classDir).isDirectory()) continue;
      for (const studentHash of fs.readdirSync(classDir)) {
        const dir = path.join(classDir, studentHash);
        if (!fs.statSync(dir).isDirectory()) continue;
        const legacyMeta = readJson(path.join(dir, 'meta.json'), null);
        if (legacyMeta && fs.existsSync(path.join(dir, 'state.bin'))) {
          this.migrateLegacy(legacyMeta.classId, legacyMeta.studentId);
        }
        for (let slot = 1; slot <= PROJECT_SLOTS; slot += 1) {
          const meta = readJson(path.join(dir, `slot-${slot}`, 'meta.json'), null);
          if (!meta || !fs.existsSync(path.join(dir, `slot-${slot}`, 'state.bin'))) continue;
          if (filter && meta.classId !== filter) continue;
          // 在存储边界补上模型名，教师端跨模型列表与导出无需猜默认模型。
          out.push({ ...meta, slot, modelId: this.modelId });
        }
      }
    }
    return out.sort((a, b) => String(b.savedAt || b.uploadedAt).localeCompare(String(a.savedAt || a.uploadedAt)));
  }

  packageSnapshot(snapshot, missingMessage) {
    if (!snapshot) throw Object.assign(new Error(missingMessage), { statusCode: 404 });
    const stateBuffer = fs.readFileSync(snapshot.state);
    const history = safeHistory(readJson(snapshot.history, { t: [] }));
    const score = {
      mode: snapshot.meta.scoreMode || 0,
      total: snapshot.meta.scoreTotal || 0,
      savedAt: snapshot.meta.savedAt || snapshot.meta.uploadedAt || null,
    };
    return {
      format: 'YunLevelProject',
      version: PROJECT_VERSION,
      manifest: {
        ...snapshot.meta,
        exportedAt: new Date().toISOString(),
        stateBytes: stateBuffer.length,
        checksum: crypto.createHash('sha256').update(stateBuffer).digest('hex'),
      },
      stateBase64: stateBuffer.toString('base64'),
      history,
      score,
    };
  }

  projectPackage(classId, studentId, slotValue) {
    return this.packageSnapshot(this.getProject(classId, studentId, slotValue), '该云端方案还没有保存内容');
  }

  currentPackage(classId, studentId) {
    return this.packageSnapshot(this.getCurrent(classId, studentId), '还没有保存当前状态');
  }

  decodeProject(project) {
    if (!project || project.format !== 'YunLevelProject' || Number(project.version) !== PROJECT_VERSION) {
      throw Object.assign(new Error('不是有效的 YunLevel 工程文件'), { statusCode: 400 });
    }
    const stateBuffer = Buffer.from(String(project.stateBase64 || ''), 'base64');
    if (!stateBuffer.length) throw Object.assign(new Error('工程文件缺少仿真状态'), { statusCode: 400 });
    const expected = String(project.manifest?.checksum || '');
    const actual = crypto.createHash('sha256').update(stateBuffer).digest('hex');
    if (expected && expected !== actual) {
      throw Object.assign(new Error('工程文件校验失败，文件可能已损坏'), { statusCode: 400 });
    }
    return { stateBuffer, history: safeHistory(project.history), actual };
  }

  writeImportedSnapshot(project, engine, files, reason, extra = {}) {
    const { stateBuffer, history, actual } = this.decodeProject(project);
    ensureDir(files.dir);
    writeFileAtomic(files.state, stateBuffer);
    writeJsonAtomic(files.history, history);
    const importedManifest = project.manifest && typeof project.manifest === 'object' ? project.manifest : {};
    const now = new Date().toISOString();
    const meta = {
      ...summarizeEngine(engine),
      ...importedManifest,
      ...extra,
      classId: engine.classId,
      studentId: engine.studentId,
      name: engine.name,
      className: engine.className,
      ownerRole: engine.ownerRole || 'student',
      savedAt: now,
      originalSavedAt: importedManifest.savedAt || importedManifest.uploadedAt || null,
      reason,
      hasState: true,
      hasHistory: true,
      checksum: actual,
    };
    writeJsonAtomic(files.meta, meta);
    return meta;
  }

  importProjectToSlot(project, engine, slotValue, reason = 'imported') {
    const slot = normalizeSlot(slotValue);
    const files = this.projectFiles(engine.classId, engine.studentId, slot);
    const now = new Date().toISOString();
    return this.writeImportedSnapshot(project, engine, files, reason, { slot, uploadedAt: now });
  }

  importProjectToCurrent(project, engine, reason = 'imported') {
    const files = this.currentFiles(engine.classId, engine.studentId);
    return this.writeImportedSnapshot(project, engine, files, reason);
  }

  saveTeacherBackup(engine, reason = 'before-load') {
    const dir = path.join(this.teacherBackupsDir, 'latest');
    ensureDir(dir);
    const state = path.join(dir, 'state.bin');
    const history = path.join(dir, 'history.json');
    const metaFile = path.join(dir, 'meta.json');
    const stateOk = copyFile(engine.stateFile, state);
    engine.saveHistory();
    const historyOk = copyFile(engine.historyFile, history);
    if (!stateOk) throw new Error('教师当前仿真状态不存在，无法自动备份');
    const meta = {
      ...summarizeEngine(engine),
      backedUpAt: new Date().toISOString(),
      reason,
      hasState: true,
      hasHistory: historyOk,
    };
    writeJsonAtomic(metaFile, meta);
    return meta;
  }

  getTeacherBackup() {
    const dir = path.join(this.teacherBackupsDir, 'latest');
    const meta = readJson(path.join(dir, 'meta.json'), null);
    if (!meta || !fs.existsSync(path.join(dir, 'state.bin'))) return null;
    return {
      dir,
      state: path.join(dir, 'state.bin'),
      history: path.join(dir, 'history.json'),
      meta,
    };
  }

  copyProjectToEngine(project, engine) {
    assertStateBelongsToModel(project && project.state, this.modelId);
    const copiedState = copyFile(project.state, engine.stateFile);
    const copiedHistory = copyFile(project.history, engine.historyFile);
    if (!copiedState) throw new Error('工程状态文件缺失，无法恢复');
    return { copiedState, copiedHistory };
  }

  copySubmissionToEngine(submission, engine) {
    return this.copyProjectToEngine(submission, engine);
  }

  copyTeacherBackupToEngine(backup, engine) {
    assertStateBelongsToModel(backup && backup.state, this.modelId);
    const copiedState = copyFile(backup.state, engine.stateFile);
    const copiedHistory = copyFile(backup.history, engine.historyFile);
    if (!copiedState) throw new Error('教师备份状态缺失，无法恢复');
    return { copiedState, copiedHistory };
  }
}

module.exports = {
  SnapshotStore,
  assertStateBelongsToModel,
  stateMagicOf,
  summarizeEngine,
  PROJECT_SLOTS,
  PROJECT_VERSION,
};
