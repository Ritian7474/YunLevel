'use strict';
// Settings contract is independent of the C++ runtime/snapshot layout.
const DEFAULT_SCORE_CONFIG = Object.freeze({
  durationUnit: 480, durationSystem: 1500, bandTank: 2, bandHx: 5,
  sysBandTank: 2, sysBandHx: 5, disturbAt: 300, disturbMv: 3, disturbDelta: -20,
  sp1: 50, sp2: 50, sp3: 50, spHx: 400,
  sysSp1: 50, sysSp2: 50, sysSp3: 50, sysSpHx: 400, initTempHx: 400,
  modeTank: 1, modeHx: 1, tankIndex: 2,
});
const ranges = {
  durationUnit: [60,3600], durationSystem: [60,7200], bandTank: [0.5,10], sysBandTank: [0.5,10],
  bandHx: [0.5,20], sysBandHx: [0.5,20], disturbAt: [0,3000], disturbMv: [0,3,true],
  disturbDelta: [-100,100], sp1: [0,100], sp2: [0,100], sp3: [0,100],
  sysSp1: [0,100], sysSp2: [0,100], sysSp3: [0,100], spHx: [200,600], sysSpHx: [200,600],
  initTempHx: [150,650], modeTank: [1,2,true], modeHx: [1,2,true], tankIndex: [0,2,true],
};
function configError(field) {
  return Object.assign(new Error(`评分配置字段无效：${field}`), { statusCode: 400, code: 'INVALID_SCORE_CONFIG' });
}
function mergeScoreConfig(current, patch = {}, legacy = false) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw configError('scoreConfig');
  const next = { ...DEFAULT_SCORE_CONFIG, ...current };
  for (const [field,value] of Object.entries(patch)) {
    const range = ranges[field];
    if (!range || typeof value !== 'number' || !Number.isFinite(value) || value < range[0] || value > range[1] || (range[2] && !Number.isInteger(value))) {
      if (legacy) continue;
      throw configError(field);
    }
    next[field] = value;
  }
  return next;
}
function scoreSystemValue(value) {
  if (![true,false,0,1,'0','1'].includes(value)) throw configError('scoreSystemOn');
  return value === true || value === 1 || value === '1';
}
function effectiveScoreConfig(settings, modelId) {
  const cfg = settings.scoreConfig;
  const hx = modelId === 'hx';
  const mode = settings.scoreSystemOn ? cfg[hx ? 'modeHx' : 'modeTank'] : 0;
  const system = mode === 2;
  return {
    revision: settings.scoreConfigRevision, mode, tank: cfg.tankIndex,
    durationUnit: cfg.durationUnit, durationSystem: cfg.durationSystem,
    bandTank: cfg[system ? 'sysBandTank' : 'bandTank'], bandHx: cfg[system ? 'sysBandHx' : 'bandHx'],
    disturbAt: cfg.disturbAt, disturbMv: cfg.disturbMv, disturbDelta: cfg.disturbDelta,
    targets: hx ? [cfg[system ? 'sysSpHx' : 'spHx']] : [1,2,3].map(i => cfg[`${system ? 'sysSp' : 'sp'}${i}`]),
    initTempHx: cfg.initTempHx,
  };
}
module.exports = { DEFAULT_SCORE_CONFIG, mergeScoreConfig, scoreSystemValue, effectiveScoreConfig };
