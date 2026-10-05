// server/models.js
// 模型注册表：把「模型差异」集中成数据，而不是散落到各处的分支。
// 参见《换热器融合方案设计 v1.1》第 5 章、第 12 章。
//
// R1 铁律：tank 的取值必须与改造前逐字一致，否则既有学生数据会取不回来。

const DEFAULT_MODEL_ID = 'tank';
// 云端槽位：1=导出云端（教师上传控制），2/3/4=学生自由上传
const CLOUD_SLOT_NAMES = { 1: '导出云端', 2: '云端2', 3: '云端3', 4: '云端4' };
const STUDENT_UPLOAD_SLOTS = [2, 3, 4];
const TEACHER_EXPORT_SLOT = 1;

// 三级液位历史字段。
// 取值与改造前 engine-session.js 中的字面量完全相同（顺序也不许变）。
const TANK_HISTORY_FIELDS = [
  't', 'h1', 'h2', 'h3', 'sp1', 'sp2', 'sp3',
  'qin', 'q12', 'q23', 'qout',
  'pump', 'fv101', 'fv102', 'fv103', 'fv104',
];

// 状态文件魔数：0x594C5631 = 'YLV1'（与 native/engine.cpp 一致）
const TANK_STATE_MAGIC = 0x594C5631;

// 换热器历史字段：与 native-hx/engine-hx.cpp 的 state 字段一一对应。
const HX_HISTORY_FIELDS = [
  't', 'ti1104', 'sp', 'ti1103', 'fi1105', 'spf',
  'fv1102', 'fv1105', 'fv1101', 'fuel', 'mw', 'level', 'hv1102', 'relieve',
  'twall', 'twater', 'qhx',
];

// 换热器状态文件魔数：0x594C4858 = 'YLHX'（与 native-hx/hx_model.h 一致）
const HX_STATE_MAGIC = 0x594C4858;

const MODEL_SPECS = {
  tank: {
    modelId: 'tank',
    displayName: '三级液位',
    scorePolicy: { targetCommand: 'SET_SP', initCommand: null },
    stateMagic: TANK_STATE_MAGIC,
    historyFields: TANK_HISTORY_FIELDS,
    stateSubdir: 'state',
    historySubdir: 'history',
    submissionsSubdir: 'submissions',
    summaryTagKeys: [
      'h1', 'h2', 'h3', 'sp1', 'sp2', 'sp3',
      'qin', 'q12', 'q23', 'qout',
      'pump', 'fv101', 'fv102', 'fv103', 'fv104',
    ],
    // 导出元数据：参数汇总、云端导出、曲线图片命名都读这里，
    // 平台导出代码不再写死 LI101 / FV101 之类的液位位号。
    exportSpec: {
      pvNames: ['LI101', 'LI102', 'LI103', 'FI101', 'FI102', 'FI103'],
      mvNames: ['FV101', 'FV102', 'FV103', 'FV104'],
      parameters: [
        { key: 'h1', label: 'LI101(%)', digits: 3 },
        { key: 'h2', label: 'LI102(%)', digits: 3 },
        { key: 'h3', label: 'LI103(%)', digits: 3 },
        { key: 'sp1', label: 'SP1(%)', digits: 3 },
        { key: 'sp2', label: 'SP2(%)', digits: 3 },
        { key: 'sp3', label: 'SP3(%)', digits: 3 },
        { key: 'qin', label: 'FI101(L/min)', digits: 3 },
        { key: 'q12', label: 'FI102(L/min)', digits: 3 },
        { key: 'q23', label: 'FI103(L/min)', digits: 3 },
        { key: 'qout', label: '出口流量(L/min)', digits: 3 },
      ],
      actuators: [
        { key: 'pump', label: 'P101', cmdKey: 'pumpCmd', mv: null },
        { key: 'fv101', label: 'FV101', cmdKey: 'fv101cmd', mv: 0 },
        { key: 'fv102', label: 'FV102', cmdKey: 'fv102cmd', mv: 1 },
        { key: 'fv103', label: 'FV103', cmdKey: 'fv103cmd', mv: 2 },
        { key: 'fv104', label: 'FV104', cmdKey: 'fv104cmd', mv: 3 },
      ],
      curveLabels: { level: '液位曲线', flow: '流量曲线', valve: '开度曲线' },
    },
  },
  hx: {
    modelId: 'hx',
    displayName: '换热器',
    scorePolicy: { targetCommand: 'SET_PVX_SP', initCommand: 'SET_INIT_TEMP' },
    stateMagic: HX_STATE_MAGIC,
    historyFields: HX_HISTORY_FIELDS,
    // 目录与液位分开：两套状态/历史/云端方案互不可见。
    stateSubdir: 'hx-state',
    historySubdir: 'hx-history',
    submissionsSubdir: 'hx-submissions',
    teacherBackupsSubdir: 'hx-teacher_backups',
    summaryTagKeys: [
      'ti1104', 'sp', 'ti1103', 'fi1105', 'spf',
      'fv1102', 'fv1101', 'fv1105', 'fuel', 'mw', 'hv1102', 'relieve',
      'level', 'twall', 'twater', 'qhx',
    ],
    exportSpec: {
      pvNames: ['TI1104', 'FI1105'],
      mvNames: ['FV1102', 'FV1101', 'FV1105', 'HV1102'],
      parameters: [
        { key: 'ti1104', label: 'TI1104 出口(℃)', digits: 2 },
        { key: 'sp', label: '出口给定(℃)', digits: 2 },
        { key: 'ti1103', label: 'TI1103 入口(℃)', digits: 2 },
        { key: 'twater', label: '出水温度(℃)', digits: 2 },
        { key: 'fi1105', label: 'FI1105(kg/s)', digits: 3 },
        { key: 'spf', label: '蒸汽给定(kg/s)', digits: 3 },
        { key: 'fuel', label: '燃料流量(kg/s)', digits: 3 },
        { key: 'mw', label: '给水流量(kg/s)', digits: 3 },
        { key: 'fv1102', label: 'FV1102(%)', digits: 2 },
        
        { key: 'fv1105', label: 'FV1105(%)', digits: 2 },
        { key: 'qhx', label: '换热量(kW)', digits: 1 },
      ],
      actuators: [
        { key: 'fv1102', label: 'FV1102', cmdKey: 'fv1102cmd', mv: 0 },
        
        { key: 'fv1105', label: 'FV1105', cmdKey: 'fv1105cmd', mv: 2 },
      ],
      curveLabels: { level: '温度曲线', flow: '流量曲线', valve: '开度曲线' },
    },
  },
};

function modelSpec(modelId) {
  const id = String(modelId || '');
  return Object.prototype.hasOwnProperty.call(MODEL_SPECS, id)
    ? MODEL_SPECS[id]
    : MODEL_SPECS[DEFAULT_MODEL_ID];
}

// 会话键。
// tank 必须与改造前 sessionKey() 的返回值逐字一致；
// 其它模型在末尾追加 ::modelId，互不冲突。
function sessionKeyForModel(classId, studentId, modelId) {
  const base = String(classId || '') + '::' + String(studentId || '');
  const id = String(modelId || DEFAULT_MODEL_ID);
  return id === DEFAULT_MODEL_ID ? base : base + '::' + id;
}

const MODEL_IDS = Object.keys(MODEL_SPECS);

// 模型显示名。导出文件名、CSV 表头、页面文案统一走这里。
function modelDisplayName(modelId) {
  return modelSpec(modelId).displayName;
}

// 导出元数据。未知模型回落到 tank，保证旧调用不会拿到 undefined。
function modelExportSpec(modelId) {
  return modelSpec(modelId).exportSpec || MODEL_SPECS[DEFAULT_MODEL_ID].exportSpec;
}

// 教师端「全部模型」筛选：'all' / '*' 展开成所有模型，其余按单个模型处理。
function resolveModelIds(modelId) {
  const id = String(modelId || '');
  if (id === 'all' || id === '*') return MODEL_IDS.slice();
  return [modelSpec(id).modelId];
}

module.exports = {
  CLOUD_SLOT_NAMES,
  STUDENT_UPLOAD_SLOTS,
  TEACHER_EXPORT_SLOT,
  DEFAULT_MODEL_ID,
  MODEL_IDS,
  HX_HISTORY_FIELDS,
  HX_STATE_MAGIC,
  MODEL_SPECS,
  TANK_HISTORY_FIELDS,
  TANK_STATE_MAGIC,
  modelDisplayName,
  modelExportSpec,
  resolveModelIds,
  modelSpec,
  sessionKeyForModel,
};
