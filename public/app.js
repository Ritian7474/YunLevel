const $ = (id) => document.getElementById(id);
const api = async (url, options = {}) => {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'same-origin',
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

const app = {
  me: null,
  view: 'control',
  state: null,
  history: {},
  streams: { level: new Set(['h1', 'h2', 'h3', 'sp1', 'sp2', 'sp3']), flow: new Set(['qin', 'q12', 'q23', 'qout']), valve: new Set(['pump', 'fv101', 'fv102', 'fv103', 'fv104']) },
  simEventSource: null,
  teacherEventSource: null,
  selectedStudent: null,
  teacherOverview: [],
  expandedTeacherParams: new Set(),
  flowYMax: null,
  scoreEndAt: null,
  scoreEndFetching: false,
  roster: { classes: [], selectedClassId: null },
  rosterImportRows: [],
  rosterImportFileName: '',
  teacherClassFilter: '',
  // 教师端看板模型筛选：'all' | 'tank' | 'hx'。导出、云端读取都跟随它。
  teacherModelFilter: 'all',
  simViews: new SimulationView.ViewStore(),
  simVisualId: null,
  showProcessWires: true,
  showSecondaryLabels: true,
  schemeMode: null,
  simInteraction: null,
  pidPanelVisible: true,
  historyClock: { offset: 0, lastRawT: null, lastDisplayT: null },
  cloudSettings: { allowStudentUpload: false, updatedAt: null },
  cloudProjects: [],
  currentState: null,
  projectSlots: 3,
  projectSlot: 1,
  cloudRecovery: null,
  teacherCloudSubmissions: [],
  teacherCloudClassFilter: '',
  teacherCloudStudentFilter: '',
  teacherCloudSelectedStudents: new Set(),
  cloudExportBusy: false,
  teacherStudentKey: null,
  teacherStudentStream: null,
  teacherHistoryClock: { offset: 0, lastRawT: null, lastDisplayT: null },
  teacherBackup: null,
  loggingOut: false,
  curve: {
    active: 'level',
    showAnnotation: true,
    annotationT: null,
    timeTag: { x: null, y: null, moved: false },
    ranges: {
      level: { x0: null, x1: null, y0: 0, y1: 100, follow: true },
      flow: { x0: null, x1: null, y0: 0, y1: null, follow: true },
      valve: { x0: null, x1: null, y0: 0, y1: 100, follow: true },
    },
    drag: null,
    layout: null,
  },
  teacherCurve: {
    // 学生实时曲线所属模型：教师看板跨模型时必须各自用自己的曲线定义。
    modelId: 'tank',
    history: { t: [] },
    streams: { level: new Set(['h1', 'h2', 'h3', 'sp1', 'sp2', 'sp3']), flow: new Set(['qin', 'q12', 'q23', 'qout']), valve: new Set(['pump', 'fv101', 'fv102', 'fv103', 'fv104']) },
    active: 'level',
    showAnnotation: true,
    annotationT: null,
    timeTag: { x: null, y: null, moved: false },
    ranges: {
      level: { x0: null, x1: null, y0: 0, y1: 100, follow: true },
      flow: { x0: null, x1: null, y0: 0, y1: null, follow: true },
      valve: { x0: null, x1: null, y0: 0, y1: 100, follow: true },
    },
    flowYMax: null,
    drag: null,
    layout: null,
  },
};


// ---- 模型描述符 ModelSpec ----------------------------------------------
// 所有模型差异集中在这里；平台功能只写一份，读这个描述符。
// tank 的取值必须与改造前逐字一致（见《换热器融合方案设计 v1.1》第 5 章）。
const TANK_CURVE_GROUPS = {
  level: {
    tabLabel: '液位曲线',
    canvasId: 'levelChart',
    yLabel: '%液位',
    unit: '%FS',
    fixedYMax: 100,
    series: [
      { key: 'h1', label: 'LI101', color: '#54d39f' },
      { key: 'h2', label: 'LI102', color: '#26a5d8' },
      { key: 'h3', label: 'LI103', color: '#f0b44d' },
      { key: 'sp1', label: 'SP1', color: '#e05252', dash: true },
      { key: 'sp2', label: 'SP2', color: '#18b6d9', dash: true },
      { key: 'sp3', label: 'SP3', color: '#e05aa8', dash: true },
    ],
  },
  flow: {
    tabLabel: '流量曲线',
    canvasId: 'flowChart',
    yLabel: 'L/min',
    unit: 'L/min',
    fixedYMax: 15,
    series: [
      { key: 'qin', label: 'FI101', color: '#1e88c8' },
      { key: 'q12', label: 'FI102', color: '#23a878' },
      { key: 'q23', label: 'FI103', color: '#8c28a0' },
      { key: 'qout', label: '出口', color: '#dc6e3c' },
    ],
  },
  valve: {
    tabLabel: '开度曲线',
    canvasId: 'valveChart',
    yLabel: '%开度',
    unit: '%',
    fixedYMax: 100,
    series: [
      { key: 'pump', label: 'P101', color: '#1e88c8' },
      { key: 'fv101', label: 'FV101', color: '#23a878' },
      { key: 'fv102', label: 'FV102', color: '#8c28a0' },
      { key: 'fv103', label: 'FV103', color: '#dc6e3c' },
      { key: 'fv104', label: 'FV104', color: '#e8f0f6' },
    ],
  },
};

const HX_CURVE_GROUPS = {
  level: {
    tabLabel: '温度曲线',
    canvasId: 'levelChart',
    yLabel: '℃',
    unit: '℃',
    fixedYMax: 600,
    series: [
      { key: 'ti1104', label: 'TI1104 出口', color: '#e05252' },
      { key: 'sp', label: 'SP 出口温度', color: '#f0b44d', dash: true },
      { key: 'ti1103', label: 'TI1103 入口', color: '#54d39f' },
      { key: 'twater', label: '出水温度', color: '#26a5d8' },
    ],
  },
  flow: {
    tabLabel: '流量曲线',
    canvasId: 'flowChart',
    yLabel: 'kg/s',
    unit: 'kg/s',
    fixedYMax: 95,
    series: [
      { key: 'fi1105', label: 'FI1105 蒸汽', color: '#8c28a0' },
      { key: 'spf', label: 'SP 蒸汽流量', color: '#e05aa8', dash: true },
      { key: 'mw', label: 'FI1102 冷却水', color: '#23a878' },
    ],
  },
  valve: {
    tabLabel: '开度曲线',
    canvasId: 'valveChart',
    yLabel: '%开度',
    unit: '%',
    fixedYMax: 100,
    series: [
      { key: 'fv1102', label: 'FV1102 冷却水', color: '#26a5d8' },
      { key: 'fv1105', label: 'FV1105 出口阀', color: '#8c28a0' },
    ],
  },
};

const MODEL_SPECS = {
  tank: {
    modelId: 'tank',
    displayName: '三级液位',
    renderer: 'tank',
    pvNames: ['LI101', 'LI102', 'LI103', 'FI101', 'FI102', 'FI103'],
    mvNames: ['FV101', 'FV102', 'FV103', 'FV104'],
    curveGroups: TANK_CURVE_GROUPS,
    flowYLimit: 20,
    flowYUnit: 'L/min',
    curveExportLabels: { level: '液位曲线', flow: '流量曲线', valve: '开度曲线' },
    historyKeys: [
      't', 'h1', 'h2', 'h3', 'sp1', 'sp2', 'sp3',
      'qin', 'q12', 'q23', 'qout',
      'pump', 'fv101', 'fv102', 'fv103', 'fv104',
    ],
    manualTargets: [
      { id: 'pumpInput', key: 'pump', label: 'P101 泵开度 %', cmd: 'PUMP', valueOf: 'pumpCmd', pump: true },
      { id: 'fv101Input', key: 'fv101', label: 'FV101 手操 %', cmd: 'VALVE', mv: 0, valueOf: 'fv101cmd' },
      { id: 'fv102Input', key: 'fv102', label: 'FV102 手操 %', cmd: 'VALVE', mv: 1, valueOf: 'fv102cmd' },
      { id: 'fv103Input', key: 'fv103', label: 'FV103 手操 %', cmd: 'VALVE', mv: 2, valueOf: 'fv103cmd' },
      { id: 'fv104Input', key: 'fv104', label: 'FV104 手操 %', cmd: 'VALVE', mv: 3, valueOf: 'fv104cmd' },
    ],
    pvCatalog: [
      { value: 0, label: 'LI101 1#罐液位', unit: '%' },
      { value: 1, label: 'LI102 2#罐液位', unit: '%' },
      { value: 2, label: 'LI103 3#罐液位', unit: '%' },
      { value: 3, label: 'FI101 给水流量', unit: 'L/min', flowOnly: true },
      { value: 4, label: 'FI102 级间流量1', unit: 'L/min', flowOnly: true },
      { value: 5, label: 'FI103 级间流量2', unit: 'L/min', flowOnly: true },
    ],
    mvCatalog: [
      { value: 0, label: 'FV101 给水总阀' },
      { value: 1, label: 'FV102 级间阀1' },
      { value: 2, label: 'FV103 级间阀2' },
      { value: 3, label: 'FV104 出口阀' },
    ],
    innerCatalog: [
      { value: 3, label: 'FI101 给水流量' },
      { value: 4, label: 'FI102 级间流量1' },
      { value: 5, label: 'FI103 级间流量2' },
      { value: 0, label: 'LI101 1#罐液位' },
      { value: 1, label: 'LI102 2#罐液位' },
      { value: 2, label: 'LI103 3#罐液位' },
    ],
    parameterTags: [
      { key: 'h1', label: 'LI101(%)', digits: 2 },
      { key: 'h2', label: 'LI102(%)', digits: 2 },
      { key: 'h3', label: 'LI103(%)', digits: 2 },
      { key: 'sp1', label: 'SP1(%)', digits: 2 },
      { key: 'sp2', label: 'SP2(%)', digits: 2 },
      { key: 'sp3', label: 'SP3(%)', digits: 2 },
      { key: 'qin', label: 'FI101(L/min)', digits: 3 },
      { key: 'q12', label: 'FI102(L/min)', digits: 3 },
      { key: 'q23', label: 'FI103(L/min)', digits: 3 },
      { key: 'qout', label: '出口流量(L/min)', digits: 3 },
      { key: 'pi101', label: 'PI101(kPa)', digits: 1 },
    ],
    teacherSummary: [
      { key: 'h1', label: 'LI101', digits: 1, unit: '%' },
      { key: 'h2', label: 'LI102', digits: 1, unit: '%' },
      { key: 'h3', label: 'LI103', digits: 1, unit: '%' },
      { key: 'pump', label: 'P101', digits: 1, unit: '%' },
      { key: 'fv101', label: 'FV101', digits: 1, unit: '%' },
      { key: 'fv102', label: 'FV102', digits: 1, unit: '%' },
      { key: 'fv103', label: 'FV103', digits: 1, unit: '%' },
      { key: 'fv104', label: 'FV104', digits: 1, unit: '%' },
    ],
    actuatorReadouts: [
      { key: 'pump', label: 'P101', cmdKey: 'pumpCmd' },
      { key: 'fv101', label: 'FV101', cmdKey: 'fv101cmd' },
      { key: 'fv102', label: 'FV102', cmdKey: 'fv102cmd' },
      { key: 'fv103', label: 'FV103', cmdKey: 'fv103cmd' },
      { key: 'fv104', label: 'FV104', cmdKey: 'fv104cmd' },
    ],
    setpointReadouts: [
      { key: 'sp1', label: 'LI101', unit: '%' },
      { key: 'sp2', label: 'LI102', unit: '%' },
      { key: 'sp3', label: 'LI103', unit: '%' },
    ],
    scoreLabels: {
      mode1: '单罐评分',
      mode2: '系统评分',
      objectLabel: '评分对象',
      targets: [
        { value: 0, label: 'LI101 1#罐' },
        { value: 1, label: 'LI102 2#罐' },
        { value: 2, label: 'LI103 3#罐' },
      ],
      rowLabels: ['LI101', 'LI102', 'LI103'],
      columns: [
        { label: '位号', key: 'name' },
        { label: '总分', key: 'total', digits: 1 },
        { label: '整定', key: 'settle', digits: 1 },
        { label: 'MAE(%FS)', key: 'mae', digits: 3 },
        { label: '超调(%FS)', key: 'overshoot', digits: 2 },
        { label: '低限时间(s)', key: 'lowTime', digits: 1 },
        { label: '超温次数', key: 'overflow', digits: 0 },
      ],
    },
    noLoopWarning: '未搭建回路，液位不会闭环',
    noDriveWarning: 'P101=0，无进水',
    driveKey: 'pump',
  },
  hx: {
    modelId: 'hx',
    displayName: '换热器',
    renderer: 'hx',
    pvNames: ['TI1104', 'FI1105'],
    mvNames: ['FV1102', 'FV1101', 'FV1105', 'HV1102'],
    curveGroups: HX_CURVE_GROUPS,
    flowYLimit: 95,
    flowYUnit: 'kg/s',
    curveExportLabels: { level: '温度曲线', flow: '流量曲线', valve: '开度曲线' },
    historyKeys: [
      't', 'ti1104', 'sp', 'ti1103', 'fi1105', 'spf',
      'fv1102', 'fv1105', 'fv1101', 'fuel', 'mw', 'level', 'hv1102', 'relieve',
      'twall', 'twater', 'qhx',
    ],
    manualTargets: [
      { id: 'fv1102Input', key: 'fv1102', label: 'FV1102 冷却水 %', cmd: 'VALVE', mv: 0, valueOf: 'fv1102', min: 0, max: 100, step: 1 },
      { id: 'fv1105Input', key: 'fv1105', label: 'FV1105 蒸汽出口阀 %', cmd: 'VALVE', mv: 2, valueOf: 'fv1105', min: 0, max: 100, step: 1 },
      { id: 'inletTempInput', key: 'ti1103', label: 'TI1103 入口蒸汽 ℃', cmd: 'INLET', valueOf: 'ti1103', min: 250, max: 650, step: 1 },
    ],
    pvCatalog: [
      { value: 0, label: 'TI1104 出口温度', unit: '℃' },
      { value: 1, label: 'FI1105 蒸汽流量', unit: 'kg/s', flowOnly: true },
    ],
    mvCatalog: [
      { value: 0, label: 'FV1102 冷却水阀' },
      { value: 2, label: 'FV1105 蒸汽出口阀' },
    ],
    innerCatalog: [
      { value: 1, label: 'FI1105 蒸汽流量' },
      { value: 0, label: 'TI1104 出口温度' },
    ],
    parameterTags: [
      { key: 'ti1104', label: 'TI1104 出口(℃)', digits: 2 },
      { key: 'sp', label: '出口给定(℃)', digits: 2 },
      { key: 'ti1103', label: 'TI1103 入口(℃)', digits: 2 },
      { key: 'twater', label: '出水温度(℃)', digits: 2 },
      { key: 'fi1105', label: 'FI1105(kg/s)', digits: 3 },
      { key: 'spf', label: '蒸汽给定(kg/s)', digits: 3 },
      { key: 'mw', label: 'FI1102 冷却水(kg/s)', digits: 3 },
      { key: 'fv1102', label: 'FV1102(%)', digits: 2 },
      { key: 'fv1105', label: 'FV1105 出口阀(%)', digits: 2 },
      { key: 'qhx', label: '换热量(kW)', digits: 1 },
    ],
    teacherSummary: [
      { key: 'ti1104', label: 'TI1104', digits: 1, unit: '℃' },
      { key: 'sp', label: 'SP', digits: 1, unit: '℃' },
      { key: 'ti1103', label: 'TI1103', digits: 1, unit: '℃' },
      { key: 'fi1105', label: 'FI1105', digits: 2, unit: 'kg/s' },
      { key: 'fv1102', label: 'FV1102', digits: 1, unit: '%' },
      { key: 'fv1105', label: 'FV1105', digits: 1, unit: '%' },
    ],
    actuatorReadouts: [
      { key: 'fv1102', label: 'FV1102 冷却水' },
      { key: 'fv1105', label: 'FV1105 蒸汽出口阀' },
    ],
    setpointReadouts: [
      { key: 'sp', label: 'TI1104 出口温度', unit: '℃' },
      { key: 'spf', label: 'FI1105 蒸汽流量', unit: 'kg/s' },
    ],
    scoreLabels: {
      mode1: '单回路评分',
      mode2: '系统评分',
      objectLabel: '评分对象',
      targets: [
        { value: 0, label: 'E1102 换热器' },
      ],
      rowLabels: ['E1102'],
      columns: [
        { label: '位号', key: 'name' },
        { label: '总分', key: 'total', digits: 1 },
        { label: '整定', key: 'settle', digits: 1 },
        { label: 'MAE(℃)', key: 'mae', digits: 2 },
        { label: '超调(℃)', key: 'overshoot', digits: 2 },
        { label: '低温时间(s)', key: 'lowTime', digits: 1 },
        { label: '超温次数', key: 'dry', digits: 0 },
      ],
    },
    noLoopWarning: '未搭建回路，出口温度不会闭环',
    noDriveWarning: '蒸汽阀全关，换热器没有汽源',
    driveKey: 'fv1105',
  },
};

let activeModelId = 'tank';
function modelSpec() {
  return MODEL_SPECS[activeModelId] || MODEL_SPECS.tank;
}
function setActiveModel(modelId) {
  activeModelId = MODEL_SPECS[modelId] ? modelId : 'tank';
}
// 教师端「全部模型」看板：每一行按自己的 modelId 取描述符，
// 不能再用全局 activeModelId 决定其它模型的列名与位号。
function specOf(modelId) {
  return MODEL_SPECS[modelId] || MODEL_SPECS.tank;
}
function modelDisplayNameOf(modelId) {
  return specOf(modelId).displayName;
}
function teacherModelLabel() {
  const id = String(app.teacherModelFilter || 'all');
  return id === 'all' ? '全部模型' : modelDisplayNameOf(id);
}

// 曲线定义、图例分组、手操目标、位号目录全部由当前模型的描述符派生，
// 平台代码不再写死液位位号。
let CURVE_DEFS = modelSpec().curveGroups;
let CURVE_SERIES_INDEX = new Map();
let CURVE_SERIES_GROUP = new Map();

function rebuildSeriesIndex() {
  CURVE_SERIES_INDEX = new Map();
  CURVE_SERIES_GROUP = new Map();
  for (const [group, definition] of Object.entries(CURVE_DEFS)) {
    for (const item of definition.series) {
      CURVE_SERIES_INDEX.set(item.key, item);
      CURVE_SERIES_GROUP.set(item.key, group);
    }
  }
}
function defaultStreams() {
  const streams = {};
  for (const [group, definition] of Object.entries(CURVE_DEFS)) {
    streams[group] = new Set(definition.series.map((item) => item.key));
  }
  return streams;
}
function defaultRangesOf(modelId) {
  const defs = specOf(modelId).curveGroups || CURVE_DEFS;
  const ranges = {};
  for (const [group, definition] of Object.entries(defs)) {
    ranges[group] = { x0: null, x1: null, y0: 0, y1: definition.fixedYMax ?? null, follow: true };
  }
  return ranges;
}
function defaultRanges() {
  return defaultRangesOf(activeModelId);
}
function flowYLimit() {
  return Number(modelSpec().flowYLimit) || 100;
}
function manualTargets() {
  return modelSpec().manualTargets || [];
}
function modelHistoryKeys() {
  return modelSpec().historyKeys || ['t'];
}
function scoreLabels() {
  return modelSpec().scoreLabels || {};
}
// 切换模型：重建曲线定义、显隐集合、坐标范围与历史缓冲区。
function applyModelSpec(modelId) {
  setActiveModel(modelId);
  CURVE_DEFS = modelSpec().curveGroups;
  rebuildSeriesIndex();
  app.streams = defaultStreams();
  app.curve.ranges = defaultRanges();
  app.curve.active = 'level';
  app.flowYMax = null;
  app.history = {};
  app.teacherCurve.streams = defaultStreams();
  app.teacherCurve.ranges = defaultRanges();
  app.teacherCurve.active = 'level';
  app.teacherCurve.flowYMax = null;
  app.historyClock = { offset: 0, lastRawT: null, lastDisplayT: null };
  app.teacherHistoryClock = { offset: 0, lastRawT: null, lastDisplayT: null };
}

const TANK_METRIC_IDS = { h1: 'mL1', h2: 'mL2', h3: 'mL3', qin: 'mQin', q12: 'mQ12', q23: 'mQ23', qout: 'mQout', pi101: 'mPi' };

function metricElementId(key) {
  if (modelSpec().renderer === 'tank') return TANK_METRIC_IDS[key] || ('m_' + key);
  return 'hxMetric_' + key;
}

function renderModelMetrics(state = app.state) {
  if (!state) return;
  for (const tag of modelSpec().parameterTags || []) {
    const el = $(metricElementId(tag.key));
    if (el) el.textContent = number(state[tag.key], tag.digits ?? 2);
  }
}

function setSelectOptions(select, items, preferredValue, selectedValue) {
  if (!select) return;
  const previous = selectedValue !== undefined ? String(selectedValue) : (select.value || String(preferredValue ?? ''));
  select.innerHTML = (items || []).map((item) => {
    const disabled = item.disabled ? ' disabled' : '';
    return '<option value="' + escapeAttr(item.value) + '"' + disabled + '>' + escapeHtml(item.label) + '</option>';
  }).join('');
  const usable = Array.from(select.options).filter((option) => !option.disabled);
  const match = usable.find((option) => option.value === previous);
  const fallback = usable.find((option) => option.value === String(preferredValue ?? ''));
  const first = usable[0];
  if (match) select.value = match.value;
  else if (fallback) select.value = fallback.value;
  else if (first) select.value = first.value;
}

function renderManualFields() {
  const grid = document.querySelector('.field-grid');
  if (!grid) return;
  grid.innerHTML = manualTargets().map((target) => {
    const min = target.min ?? 0;
    const max = target.max ?? 100;
    const step = target.step ?? 1;
    const value = target.cmd === 'INLET' ? 400 : 0;
    return '<label>' + escapeHtml(target.label) + '<input id="' + escapeAttr(target.id) + '" type="number" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '"></label>';
  }).join('');
}

function renderMetricGrid() {
  const grid = $('metricGrid');
  if (!grid) return;
  grid.innerHTML = (modelSpec().parameterTags || []).map((tag) => '<div><span>' + escapeHtml(tag.label.replace(/\([^)]*\)$/, '')) + '</span><b id="' + escapeAttr(metricElementId(tag.key)) + '">-</b></div>').join('');
}

function renderBuilderCatalogs() {
  const spec = modelSpec();
  const buildType = $('buildType');
  // 流量/温度都可作为单回路被控量做 PID（含 FI1105）；flowOnly 仅影响显示单位。
  setSelectOptions($('buildPv'), (spec.pvCatalog || []).map((item) => ({ ...item, disabled: false })), 0, '');
  setSelectOptions($('buildMv'), spec.mvCatalog || [], 0, '');
  setSelectOptions($('buildInner'), spec.innerCatalog || [], (spec.innerCatalog || [])[0]?.value, '');
}

function bindFlowYMax(inputId, curve) {
  const input = $(inputId);
  if (!input) return;
  const limit = flowYLimit();
  input.min = '1';
  input.max = String(limit);
  input.step = limit <= 20 ? '0.5' : '1';
  const current = normalizedFlowYMax(curve.flowYMax);
  curve.flowYMax = current;
  input.value = current === null ? '' : String(current);
  input.oninput = () => {
    curve.flowYMax = normalizedFlowYMax(input.value);
    scheduleCurveDraw(curve);
  };
  input.onchange = () => {
    curve.flowYMax = normalizedFlowYMax(input.value);
    input.value = curve.flowYMax === null ? '' : String(curve.flowYMax);
    scheduleCurveDraw(curve);
  };
}

function bindCurveSeriesButtons() {
  document.querySelectorAll('.curve-stage .legend button[data-series]').forEach((button) => {
    button.onclick = () => {
      const key = button.dataset.series;
      const stream = seriesGroup(key);
      if (stream.has(key)) stream.delete(key); else stream.add(key);
      syncLegend();
      drawStudentCharts();
    };
  });
  document.querySelectorAll('[data-curve-tab]').forEach((button) => {
    button.onclick = () => switchCurveTab(button.dataset.curveTab);
  });
}

function renderCurveDefinitionControls() {
  document.querySelectorAll('[data-curve-tab]').forEach((button) => {
    const definition = CURVE_DEFS[button.dataset.curveTab];
    if (definition) button.textContent = definition.tabLabel;
  });
  document.querySelectorAll('[data-curve-stage]').forEach((stage) => {
    const group = stage.dataset.curveStage;
    const definition = CURVE_DEFS[group];
    const legend = stage.querySelector('.legend');
    if (!definition || !legend) return;
    const limit = flowYLimit();
    const yInput = group === 'flow' ? '<label class="y-max">Y 上限<input id="flowYMax" type="number" min="1" max="' + limit + '" step="' + (limit <= 20 ? '0.5' : '1') + '" placeholder="自动"></label>' : '';
    legend.innerHTML = definition.series.map((item) => '<button data-series="' + escapeAttr(item.key) + '" class="' + (app.streams[group]?.has(item.key) ? 'active' : '') + '">' + escapeHtml(item.label) + '</button>').join('') + yInput;
  });
  bindFlowYMax('flowYMax', app.curve);
  bindCurveSeriesButtons();
  syncLegend();
  bindFlowYMax('teacherFlowYMax', app.teacherCurve);
  renderTeacherLegend();
}

function renderScoreDefinition() {
  const labels = scoreLabels();
  const one = $('scoreTankBtn');
  const all = $('scoreSystemBtn');
  if (one) one.textContent = labels.mode1 || '单对象评分';
  if (all) all.textContent = labels.mode2 || '系统评分';
  const targetRow = $('scoreTargetRow');
  if (targetRow) {
    targetRow.innerHTML = (labels.targets || []).map((item, index) => '<button data-score-tank="' + escapeAttr(item.value) + '" class="' + (index === 0 ? 'active' : '') + '">' + escapeHtml(item.label) + '</button>').join('');
    targetRow.querySelectorAll('[data-score-tank]').forEach((button) => {
      button.onclick = () => sendCommand('SCORE_TANK ' + Number(button.dataset.scoreTank)).catch((e) => toast(e.message));
    });
  }
  const head = $('scoreTableHead');
  if (head) head.innerHTML = '<tr>' + (labels.columns || []).map((column) => '<th>' + escapeHtml(column.label) + '</th>').join('') + '</tr>';
}

function renderTeacherDefinition() {
  const single = String(app.teacherModelFilter || 'all') !== 'all';
  const summary = single ? (modelSpec().teacherSummary || []) : [];
  const head = $('teacherOverviewHead');
  if (head) {
    const middle = single
      ? summary.map((item) => '<th>' + escapeHtml(item.label) + '</th>').join('')
      : '<th>关键测量</th>';
    head.innerHTML = '<tr><th>学号</th><th>姓名</th><th>班级</th><th>模型</th><th>状态</th>'
      + middle + '<th>回路</th><th>评分</th><th>操作</th></tr>';
  }
  const cloudHead = $('cloudValueHead');
  if (cloudHead) {
    cloudHead.textContent = single
      ? summary.map((item) => item.label).join(' / ')
      : '关键测量';
  }
  if (Array.isArray(app.teacherOverview)) renderTeacherRows();
}
function renderSpecShell() {
  const spec = modelSpec();
  const title = spec.displayName + ' PID 云仿真';
  document.title = title;
  const loginTitle = $('loginTitle');
  const appTitle = $('appTitle');
  const modelBadge = $('modelBadge');
  if (loginTitle) loginTitle.textContent = title;
  if (appTitle) appTitle.textContent = title;
  if (modelBadge) modelBadge.textContent = spec.displayName;
  $('processVisual')?.classList.toggle('hidden', spec.renderer === 'hx');
  $('hxProcessVisual')?.classList.toggle('hidden', spec.renderer !== 'hx');
  renderCurveDefinitionControls();
  renderManualFields();
  renderMetricGrid();
  renderBuilderCatalogs();
  renderScoreDefinition();
  renderTeacherDefinition();
  if (app.state) {
    renderModelMetrics(app.state);
    renderProcessDiagram(app.state);
  }
  requestAnimationFrame(() => {
    renderProcessWires();
    applySimScale();
  });
}

Object.defineProperty(app.curve, 'history', {
  enumerable: true,
  get: () => app.history,
  set: (value) => { app.history = value || { t: [] }; },
});

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function localFileStamp(date = new Date()) {
  const part = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

function safeFilePart(value, fallback = 'export') {
  const text = String(value ?? '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 60);
  return text || fallback;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  if (/^[=+@-]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvDocument(rows) {
  return `\ufeff${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadTextFile(text, fileName, mime = 'text/csv;charset=utf-8') {
  downloadBlob(new Blob([text], { type: mime }), fileName);
}

function parameterNumber(value, digits = 3) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : '';
}

function currentExportUser() {
  if (app.me?.role === 'student') return app.me.studentId || app.me.name || 'student';
  return app.me?.role === 'teacher' ? 'teacher' : 'user';
}

function currentClass() {
  return app.roster.classes.find((item) => item.id === app.roster.selectedClassId) || null;
}

function filteredTeacherOverview() {
  const modelFilter = String(app.teacherModelFilter || 'all');
  return app.teacherOverview.filter((item) => {
    if (app.teacherClassFilter && item.classId !== app.teacherClassFilter) return false;
    if (modelFilter !== 'all' && (item.modelId || 'tank') !== modelFilter) return false;
    return true;
  });
}

// 教师端所有看板/云端/评分接口共用同一组查询参数：班级 + 模型筛选。
function teacherQueryParams() {
  const params = new URLSearchParams();
  if (app.teacherClassFilter) params.set('classId', app.teacherClassFilter);
  params.set('model', String(app.teacherModelFilter || 'all'));
  return params.toString();
}
function toast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 2800);
}

function setConnection(ok, text) {
  const dot = $('connectionDot');
  dot.className = `status-dot ${ok ? 'online' : 'offline'}`;
  $('connectionText').textContent = text;
}

function showLogin(error = '') {
  switchView('control');
  app.selectedStudent = null;
  app.me = null;
  app.state = null;
  app.history = {};
  app.loggingOut = false;
  $('loginView').classList.remove('hidden');
  $('appView').classList.add('hidden');
  $('loginError').textContent = error;
  if (app.simEventSource) app.simEventSource.close();
  if (app.teacherEventSource) app.teacherEventSource.close();
  closeTeacherStudentStream();
  app.simEventSource = null;
  app.teacherEventSource = null;
}

function showApp() {
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('userLine').textContent = app.me.role === 'teacher'
    ? '教师教学演示'
    : `${app.me.className} / ${app.me.studentId} / ${app.me.name}`;
  document.querySelectorAll('.teacher-only').forEach((el) => {
    el.classList.toggle('hidden', app.me.role !== 'teacher');
  });
  document.querySelectorAll('.student-only').forEach((el) => {
    el.classList.toggle('hidden', app.me.role !== 'student');
  });
  updateScoreTabAccess();
  switchView('control');
}

function switchView(view) {
  if (view === 'score') {
    const score = app.state?.score || {};
    if (score.active && !score.finished) {
      toast('评分进行中，结束前不能查看评分结果');
      return;
    }
  }
  app.view = view;
  document.querySelectorAll('#mainTabs .tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === view);
  });
  document.querySelectorAll('.view').forEach((el) => {
    el.classList.toggle('active', el.id === `view${view[0].toUpperCase()}${view.slice(1)}`);
  });
  if (view === 'curves') scheduleStudentCharts();
  if (view === 'teacher') loadTeacher();
  else closeTeacherStudentStream();
  if (view === 'roster') loadRoster();
  if (view === 'control') applySimScale();
  else setSimExpanded(false);
}

async function sendCommand(cmd) {
  if (!app.me || !['student', 'teacher'].includes(app.me.role)) throw new Error('当前账号不能操作仿真');
  const result = await api('/api/command', { method: 'POST', body: JSON.stringify({ cmd }) });
  if (result.state) updateState(result.state);
  return result;
}

function number(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

// Ti 趋于无穷大时按「无积分」处理，界面上仍然看得见 inf。
function tiText(value) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n) || n < 0) return 'inf';
  return number(n, 1);
}

function setValueIfIdle(id, value) {
  const el = $(id);
  if (!el || document.activeElement === el || el.dataset.dirty === '1') return;
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  el.value = n.toFixed(1);
}

function simulationPaused() {
  return !!app.state?.running && !!app.state?.paused;
}

function updateScoreTabAccess() {
  const tab = document.querySelector('#mainTabs [data-view="score"]');
  if (!tab) return;
  tab.classList.remove('locked');
  const score = app.state?.score || {};
  tab.title = score.active ? '查看评分（进行中）' : '查看评分与成绩';
}

function updateProcessFlows(state) {
  const flows = {
    qin: { label: 'FI101', value: Number(state.qin) },
    q12: { label: 'FI102', value: Number(state.q12) },
    q23: { label: 'FI103', value: Number(state.q23) },
    qout: { label: '出口', value: Number(state.qout) },
  };
  Object.entries(flows).forEach(([key, flow]) => {
    const value = Math.max(0, Number.isFinite(flow.value) ? flow.value : 0);
    const level = Math.max(0, Math.min(1, value / 8));
    document.querySelectorAll(`.pipe[data-flow="${key}"]`).forEach((pipe) => {
      pipe.style.setProperty('--flow-level', level.toFixed(3));
      pipe.classList.toggle('flowing', value > 0.03);
      const ribbon = pipe.querySelector('.flow-ribbon');
      if (ribbon) ribbon.style.animationDuration = `${(1.55 - level * 1.05).toFixed(2)}s`;
      const label = pipe.querySelector('.flow-label');
      if (label) label.textContent = `${flow.label} ${number(value, 2)} L/min`;
    });
  });
}

function updateDriverBadges(state) {
  const drivers = new Map();
  (Array.isArray(state.cascades) ? state.cascades : []).forEach((casc) => {
    const mv = Number(casc.mv);
    if (Number.isInteger(mv)) drivers.set(mv, { label: '串级', className: 'cascade' });
  });
  (Array.isArray(state.loops) ? state.loops : []).forEach((loop) => {
    const mv = Number(loop.mv);
    if (!Number.isInteger(mv) || drivers.has(mv)) return;
    drivers.set(mv, loop.manual
      ? { label: '手动', className: 'manual' }
      : { label: '自动', className: 'auto' });
  });
  ['fv101', 'fv102', 'fv103', 'fv104'].forEach((id, index) => {
    const badge = $(`${id}Driver`);
    if (!badge) return;
    const driver = drivers.get(index);
    badge.textContent = driver?.label || (Number(state[id]) > 0.5 ? '手操' : '未用');
    badge.className = `driver-badge ${driver?.className || 'manual'}`;
  });
  const pump = $('pumpDriver');
  if (pump) {
    pump.textContent = Number(state.pump || 0) > 0.5 ? '运行' : '手操';
    pump.className = 'driver-badge manual';
  }
}

function processVisualAnchor(element, position = 'center') {
  if (!element) return null;
  const centerX = element.offsetLeft + element.offsetWidth / 2;
  const topY = element.offsetTop + 8;
  const centerY = element.offsetTop + element.offsetHeight / 2;
  return { x: centerX, y: position === 'top' ? topY : centerY };
}

// D2：位号/阀门到仿真图锚点。液位与换热器各自给出自己的锚点。
function processPvAnchor(pv) {
  if (modelSpec().renderer === 'hx') return hxPvAnchor(pv);
  const index = Number(pv);
  if (index >= 0 && index <= 2) return processVisualAnchor($(`tank${index + 1}Node`), 'top');
  const flowKey = index === 3 ? 'qin' : (index === 4 ? 'q12' : (index === 5 ? 'q23' : null));
  if (!flowKey) return null;
  return processVisualAnchor(document.querySelector(`.pipe[data-flow="${flowKey}"]`), 'top');
}

function pidMvAnchor(mv) {
  if (modelSpec().renderer === 'hx') return hxMvAnchor(mv);
  return processVisualAnchor($(`fv10${Number(mv) + 1}Node`), 'top');
}

function pidVisual() {
  return modelSpec().renderer === 'hx' ? $('hxProcessVisual') : $('processVisual');
}

function pidWireSvg() {
  return modelSpec().renderer === 'hx' ? $('hxLoopWires') : $('loopWires');
}

// 换热器 P&ID 锚点：0 = 出口温度测点在换热器本体上，1 = 蒸汽流量测点在蒸汽管上。
function hxPvAnchor(pv) {
  const index = Number(pv);
  if (index === 0) return processVisualAnchor($('hxShellNode'), 'top');
  return processVisualAnchor(document.querySelector('#hxProcessVisual .pipe[data-flow="steam"]'), 'top');
}

function hxMvAnchor(mv) {
  const index = Number(mv);
  const ids = ['hxFV1102Node', 'hxFV1101Node', 'hxFV1105Node', 'hxHV1102Node'];
  return processVisualAnchor($(ids[index] || ids[0]), 'top');
}

function wirePathParts(from, to, kind, label) {
  if (!from || !to) return null;
  const dx = to.x - from.x;
  const dy = Math.abs(to.y - from.y);
  const lift = Math.max(42, Math.min(118, Math.max(dy * 0.55, Math.abs(dx) * 0.13)));
  const controlY = Math.min(from.y, to.y) - lift;
  const c1x = from.x + dx * 0.28;
  const c2x = to.x - dx * 0.28;
  const path = `M ${from.x} ${from.y} C ${c1x} ${controlY}, ${c2x} ${controlY}, ${to.x} ${to.y}`;
  const textX = (from.x + to.x) / 2;
  const textY = controlY - 4;
  return { path, textX, textY, kind, label };
}

function renderProcessWires() {
  const svg = pidWireSvg();
  const visual = pidVisual();
  if (!svg || !visual) return;
  if (!app.showProcessWires || !app.state) {
    svg.innerHTML = '';
    return;
  }
  const width = Math.max(visual.scrollWidth, visual.offsetWidth);
  const height = Math.max(visual.scrollHeight, visual.offsetHeight);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  const parts = [
    '<defs>'
    + '<marker id="wireArrowLoop" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#45d3a9"/></marker>'
    + '<marker id="wireArrowOuter" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#f0b44d"/></marker>'
    + '<marker id="wireArrowInner" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#b98cff"/></marker>'
    + '</defs>',
  ];
  const addWire = (wire, pathClass, textClass, marker) => {
    if (!wire) return;
    parts.push(`<path class="${pathClass}" d="${wire.path}" marker-end="url(#${marker})"/>`);
    parts.push(`<text class="${textClass}" x="${wire.textX}" y="${wire.textY}" text-anchor="middle">${wire.label}</text>`);
  };
  (Array.isArray(app.state.loops) ? app.state.loops : []).forEach((loop) => {
    const pv = Number(loop.pv);
    const mv = Number(loop.mv);
    const from = processPvAnchor(pv);
    const to = pidMvAnchor(mv);
    addWire(wirePathParts(from, to, 'loop', `${mvName(mv)}→${pvName(pv)}`), 'wire-loop', 'wire-text-loop', 'wireArrowLoop');
  });
  (Array.isArray(app.state.cascades) ? app.state.cascades : []).forEach((casc) => {
    const outer = Number(casc.outer);
    const inner = Number(casc.inner);
    const mv = Number(casc.mv);
    const outerAnchor = processPvAnchor(outer);
    const innerAnchor = processPvAnchor(inner);
    const valveAnchor = pidMvAnchor(mv);
    addWire(wirePathParts(outerAnchor, innerAnchor, 'outer', `${pvName(inner)}→${pvName(outer)}`), 'wire-outer', 'wire-text-outer', 'wireArrowOuter');
    addWire(wirePathParts(innerAnchor, valveAnchor, 'inner', `${mvName(mv)}→${pvName(inner)}`), 'wire-inner', 'wire-text-inner', 'wireArrowInner');
  });
  svg.innerHTML = parts.join('');
}

// ---- D2：P&ID 渲染器 --------------------------------------------------
// 模型差异只在这里分派：三级液位渲染三罐流程，换热器渲染 E1102 流程。
function renderProcessDiagram(state) {
  if (modelSpec().renderer === 'hx') renderHxPid(state);
  else renderTankPid(state);
  updateSimWarning(state);
}

function updateSimWarning(state) {
  const spec = modelSpec();
  const warning = $('simWarning');
  if (!warning) return;
  const loops = Array.isArray(state.loops) ? state.loops : [];
  const cascades = Array.isArray(state.cascades) ? state.cascades : [];
  const driving = Number(state[spec.driveKey] || 0) > 0.5;
  let warningText = '';
  if (state.running && !loops.length && !cascades.length) warningText = spec.noLoopWarning || '';
  else if (state.running && !driving) warningText = spec.noDriveWarning || '';
  warning.textContent = warningText;
  warning.classList.toggle('hidden', !warningText);
}

function renderTankPid(state) {
  const running = !!state.running;
  const setText = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };
  setText('vPump', `${number(state.pump, 0)}%`);
  setText('vFv101', `${number(state.fv101, 0)}%`);
  setText('vFv102', `${number(state.fv102, 0)}%`);
  setText('vFv103', `${number(state.fv103, 0)}%`);
  setText('vFv104', `${number(state.fv104, 0)}%`);
  ['pump', 'fv101', 'fv102', 'fv103', 'fv104'].forEach((id) => {
    const node = $(`${id}Node`);
    if (node) node.classList.toggle('on', Number(state[id]) > 0.5 || (id === 'pump' && Number(state.pump) > 0.5));
  });
  const levels = [state.h1, state.h2, state.h3];
  levels.forEach((lv, i) => {
    const lvNum = Math.max(0, Math.min(100, Number(lv) || 0));
    const fill = $(`tank${i + 1}Fill`);
    if (fill) {
      fill.style.height = `${lvNum}%`;
      fill.classList.toggle('is-empty', !(Number(lv) > 0.01));
    }
    const tankNode = fill ? fill.closest('.tank-node') : null;
    if (tankNode) {
      tankNode.classList.toggle('alarm-high', running && lvNum >= 90);
      tankNode.classList.toggle('alarm-low', running && lvNum <= 5);
    }
    const sp = Math.max(0, Math.min(100, Number(state[`sp${i + 1}`]) || 0));
    const marker = $(`tank${i + 1}SpMarker`);
    if (marker) {
      marker.style.bottom = `${sp}%`;
      marker.classList.toggle('close', Math.abs(lvNum - sp) <= 2);
      const delta = lvNum - sp;
      setText(`tank${i + 1}SpLabel`, `SP ${number(sp, 1)}% Δ${delta >= 0 ? '+' : ''}${number(delta, 1)}`);
    }
    const measured = Number(state[`h${i + 1}mm`]);
    const levelText = `${number(lvNum, 1)}% · ${number(Number.isFinite(measured) ? measured : lvNum * 10, 0)} mm`;
    setText(`vH${i + 1}`, levelText);
    setText(`vSp${i + 1}`, `SP ${number(sp, 1)}%`);
    setText(`mL${i + 1}`, levelText);
  });
  setText('mQin', `${number(state.qin, 2)} L/min`);
  setText('mQ12', `${number(state.q12, 2)} L/min`);
  setText('mQ23', `${number(state.q23, 2)} L/min`);
  setText('mQout', `${number(state.qout, 2)} L/min`);
  setText('mPi', `${number(state.pi101, 1)} kPa`);
  updateProcessFlows(state);
  updateDriverBadges(state);
  requestAnimationFrame(renderProcessWires);
}

function renderHxPid(state) {
  const running = !!state.running;
  const drivers = new Map();
  (Array.isArray(state.cascades) ? state.cascades : []).forEach((casc) => {
    drivers.set(Number(casc.mv), { label: '串级', className: 'cascade' });
  });
  (Array.isArray(state.loops) ? state.loops : []).forEach((loop) => {
    const mv = Number(loop.mv);
    if (drivers.has(mv)) return;
    drivers.set(mv, loop.manual ? { label: '手动', className: 'manual' } : { label: '自动', className: 'auto' });
  });
  const valves = [
    { key: 'fv1102', mv: 0, node: 'hxFV1102Node', value: 'hxVFv1102', driver: 'hxFv1102Driver' },
    { key: 'fv1101', mv: 1, node: 'hxFV1101Node', value: 'hxVFv1101', driver: 'hxFv1101Driver' },
    { key: 'fv1105', mv: 2, node: 'hxFV1105Node', value: 'hxVFv1105', driver: 'hxFv1105Driver' },
    { key: 'hv1102', mv: 3, node: 'hxHV1102Node', value: 'hxVHv1102', driver: 'hxHv1102Driver' },
  ];
  valves.forEach((valve) => {
    const pct = Number(state[valve.key]) || 0;
    const node = $(valve.node);
    if (node) node.classList.toggle('on', pct > 0.5);
    const label = $(valve.value);
    if (label) label.textContent = `${number(pct, 0)}%`;
    const badge = $(valve.driver);
    if (badge) {
      const driver = drivers.get(valve.mv);
      badge.textContent = driver?.label || (pct > 0.5 ? '手操' : '未用');
      badge.className = `driver-badge ${driver?.className || 'manual'}`;
    }
  });
  const temp = Number(state.ti1104) || 0;
  const sp = Number(state.sp) || 0;
  const inlet = Number(state.ti1103) || 0;
  const waterOut = Number(state.twater) || 0;
  const steam = Number(state.fi1105) || 0;
  const steamSp = Number(state.spf) || 0;
  const feed = Number(state.mw) || 0;
  const fuel = Number(state.fuel) || 0;
  const duty = Number(state.qhx) || 0;
  const level = clamp(Number(state.level) || 0, 0, 100);
  const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  setText('hxTi1104Readout', `${number(temp, 1)} ℃`);
  setText('hxTi1104Set', `SP ${number(sp, 1)} ℃`);
  setText('hxTi1103Readout', `TI1103 ${number(inlet, 1)} ℃`);
  setText('hxTwaterReadout', `出水 ${number(waterOut, 1)} ℃`);
  setText('hxFi1105Readout', `${number(steam, 2)} kg/s`);
  setText('hxSpfReadout', `SP ${number(steamSp, 2)} kg/s`);
  setText('hxMwReadout', `给水 ${number(feed, 2)} kg/s`);
  setText('hxInstFi1102Value', `${number(feed, 2)}`);
  setText('hxFuelReadout', `燃料 ${number(fuel, 3)} kg/s`);
  setText('hxFuelFlowReadout', `${number(fuel, 3)} kg/s`);
  setText('hxQhxReadout', `换热 ${number(duty, 1)} kW`);
  setText('hxLevelText', `${number(level, 1)} %`);
  setText('hxDeltaText', `Δ${(temp - sp) >= 0 ? '+' : ''}${number(temp - sp, 1)} ℃`);
  // KPI 顶栏：出口温度/给定/偏差/蒸汽流量/换热量/壁温。
  const wallTemp = Number(state.twall) || 0;
  setText('hxKpiTi1104', `${number(temp, 1)} ℃`);
  setText('hxKpiSp', `${number(sp, 1)} ℃`);
  setText('hxKpiDelta', `Δ${(temp - sp) >= 0 ? '+' : ''}${number(temp - sp, 1)} ℃`);
  setText('hxKpiFi1105', `${number(steam, 2)} kg/s`);
  setText('hxKpiQhx', `${number(duty, 1)} kW`);
  setText('hxKpiTwall', `${number(wallTemp, 1)} ℃`);
  const inletTemp = Number(state.ti1103) || 0;
  setText('hxInstTi1104Value', `${number(temp, 1)} ℃`);
  setText('hxInstFi1105Value', `${number(steam, 2)}`);
  setText('hxInstTi1103Value', `${number(inletTemp, 1)} ℃`);
  const kpiTempCell = $('hxKpiTi1104')?.parentElement;
  if (kpiTempCell) kpiTempCell.classList.toggle('warn', running && (temp >= 560 || temp <= 320));
  const kpiDeltaCell = $('hxKpiDelta')?.parentElement;
  if (kpiDeltaCell) kpiDeltaCell.classList.toggle('warn', running && Math.abs(temp - sp) > 40);
  $('hxInstTi1104')?.classList.toggle('warn', running && (temp >= 560 || temp <= 320));
  $('hxInstTi1103')?.classList.toggle('warn', running && inletTemp >= 560);
  const fill = $('hxLevelFill');
  if (fill) {
    fill.style.height = `${level}%`;
    fill.classList.toggle('is-empty', level <= 0.01);
  }
  const shell = $('hxShellNode');
  if (shell) {
    shell.classList.toggle('alarm-high', running && temp >= 560);
    shell.classList.toggle('alarm-low', running && temp <= 320);
  }
  updateHxFlows(state);
  requestAnimationFrame(renderProcessWires);
}

function updateHxFlows(state) {
  const flows = {
    steam: { label: 'FI1105', value: Number(state.fi1105), unit: 'kg/s', full: 90 },
    water: { label: '给水', value: Number(state.mw), unit: 'kg/s', full: 90 },
    fuel: { label: '燃料', value: Number(state.fuel), unit: 'kg/s', full: 6 },
  };
  Object.entries(flows).forEach(([key, flow]) => {
    const value = Math.max(0, Number.isFinite(flow.value) ? flow.value : 0);
    const ratio = Math.max(0, Math.min(1, value / flow.full));
    document.querySelectorAll(`#hxProcessVisual .pipe[data-flow="${key}"]`).forEach((pipe) => {
      pipe.style.setProperty('--flow-level', ratio.toFixed(3));
      pipe.classList.toggle('flowing', value > 0.02);
      const ribbon = pipe.querySelector('.flow-ribbon');
      if (ribbon) ribbon.style.animationDuration = `${(1.55 - ratio * 1.05).toFixed(2)}s`;
      const label = pipe.querySelector('.flow-label');
      if (label) label.textContent = `${flow.label} ${number(value, 2)} ${flow.unit}`;
    });
  });
}

// 手操输入框由描述符决定：液位是泵 + 四个阀，换热器是三个阀。
function syncManualInputs(state) {
  for (const target of manualTargets()) {
    setValueIfIdle(target.id, state[target.valueOf]);
  }
}
function updateState(state) {
  app.state = state;
  const running = !!state.running;
  const paused = !!state.paused;
  $('runState').textContent = running ? (paused ? '暂停' : '运行中') : '未启动';
  $('runState').className = `badge ${running ? (paused ? 'paused' : 'running') : 'stopped'}`;
  const scoreState = state.score || {};
  const watermark = scoreState.active ? '评分进行中' : (running && paused ? '已暂停' : '');
  document.querySelectorAll('.sim-watermark').forEach((element) => {
    element.textContent = watermark;
    element.classList.toggle('hidden', !watermark);
  });
  const reset = $('resetBtn');
  if (reset) {
    const canReset = !running || paused;
    reset.disabled = !canReset;
    reset.title = running && !paused ? '请先暂停仿真，再回到冷态' : '回到冷态';
  }
  $('simTime').textContent = `t = ${number(state.sim_time ?? state.simTime ?? 0, 1)} s`;
  renderModelMetrics(state);
  renderProcessDiagram(state);
  syncManualInputs(state);
  { const bb = $('biasBtn'); if (bb) { bb.textContent = `前馈偏置：${state.bias ? '开' : '关'}`; bb.classList.toggle('on', !!state.bias); } }
  syncSchemeControls(state);
  syncManualAvailability(state);
  renderLoops(state);
  renderPidProcess(state);
  renderScore(state);
  updateScoreTabAccess();
  renderStudentCloudStatus();
  if (app.view === 'curves') scheduleStudentCharts();
}

function syncSchemeControls(state) {
  const mode = Number(state.mode || 0) === 1 ? 1 : 0;
  document.querySelectorAll('[data-scheme]').forEach((button) => {
    const active = Number(button.dataset.scheme) === mode;
    button.classList.toggle('active', active);
    button.disabled = !!state.running;
    button.title = state.running ? '运行中不能切换单回路/串级方案' : '';
  });
  const buildType = $('buildType');
  if (!buildType) return;
  const previousMode = app.schemeMode;
  if (previousMode !== mode) {
    app.schemeMode = mode;
    buildType.value = mode === 1 ? 'casc' : 'loop';
  }
  const cascadeOption = buildType.querySelector('option[value="casc"]');
  if (cascadeOption) cascadeOption.disabled = mode !== 1;
  if (mode !== 1 && buildType.value === 'casc') buildType.value = 'loop';
  const showCascadeBuilder = mode === 1 && buildType.value === 'casc';
  document.querySelectorAll('.casc-only').forEach((el) => el.classList.toggle('hidden', !showCascadeBuilder));
  syncBuildPvOptions();
}

function syncBuildPvOptions() {
  const select = $('buildPv');
  const buildType = $('buildType');
  if (!select || !buildType) return;
  // 流量被控量也可在单回路使用（与内核 LOOP_ADD 一致），不再随“串级”强制禁用。
  Array.from(select.options).forEach((option) => {
    option.disabled = false;
  });
}

function syncManualAvailability(state) {
  const isCascadeMode = Number(state.mode || 0) === 1;
  const occupied = new Set();
  (Array.isArray(state.loops) ? state.loops : []).forEach((loop) => occupied.add(Number(loop.mv)));
  if (isCascadeMode) (Array.isArray(state.cascades) ? state.cascades : []).forEach((casc) => occupied.add(Number(casc.mv)));
  for (const target of manualTargets()) {
    const input = $(target.id);
    if (!input) continue;
    const isOccupied = !target.pump && occupied.has(Number(target.mv));
    input.disabled = isOccupied;
    input.title = isOccupied ? '该执行器已由回路控制，请使用回路卡片的手动输出' : '';
  }
  const apply = $('applyManualBtn');
  if (apply) {
    apply.disabled = false;
    apply.title = '应用未由回路占用的手操值';
  }
}

function loopStructureSignature(loops, cascades) {
  return [
    loops.map((loop) => `L${loop.pv}:${loop.mv}`).join(','),
    cascades.map((casc) => `C${casc.mv}:${casc.outer}:${casc.inner}`).join(','),
  ].join('|');
}

function setLoopCardInput(card, field, value) {
  const input = card?.querySelector(`[data-field="${field}"]`);
  if (!input || document.activeElement === input || input.dataset.dirty === '1') return;
  const next = String(value);
  if (input.value !== next) input.value = next;
}

function setLoopCardReading(card, field, value) {
  const el = card?.querySelector(`[data-reading="${field}"]`);
  if (!el) return;
  const next = String(value);
  if (el.textContent !== next) el.textContent = next;
}

function pvCatalogItem(pv) {
  return (modelSpec().pvCatalog || []).find((item) => Number(item.value) === Number(pv)) || {};
}

function pvValueText(pv, value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return number(n, digits) + ' ' + (pvCatalogItem(pv).unit || '');
}

function loopPvText(loop) {
  const value = Number(loop?.pvValue);
  return Number.isFinite(value) ? pvValueText(loop.pv, value, 1) : '--';
}

function cascadePvText(casc, side) {
  const outer = side === 'outer';
  const value = Number(outer ? casc?.outerPvValue : casc?.innerPvValue);
  if (!Number.isFinite(value)) return '--';
  const pv = Number(outer ? casc.outer : casc.inner);
  return pvValueText(pv, value, pvCatalogItem(pv).flowOnly ? 2 : 1);
}

function syncLoopCards(loops, cascades) {
  const wrap = $('loopCards');
  loops.forEach((loop, index) => {
    const card = wrap.querySelector(`[data-loop-card="${index}"]`);
    if (!card) return;
    card.querySelector(`[data-loop-state="${index}"]`).textContent = `${loop.manual ? '手动' : '自动'} / ${loop.action > 0 ? '正作用' : '反作用'}`;
    setLoopCardReading(card, 'pv', loopPvText(loop));
    setLoopCardInput(card, 'sp', number(loop.sp, 1));
    setLoopCardInput(card, 'kp', number(loop.kp, 3));
    setLoopCardInput(card, 'ti', tiText(loop.ti));
    setLoopCardInput(card, 'td', number(loop.td, 1));
    setLoopCardInput(card, 'manualOut', number(loop.manualOut, 1));
    const auto = card.querySelector(`[data-loop-auto="${index}"]`);
    const action = card.querySelector(`[data-loop-action="${index}"]`);
    auto.dataset.manual = loop.manual ? '0' : '1';
    auto.textContent = loop.manual ? '投自动' : '投手动';
    action.dataset.action = loop.action > 0 ? '-1' : '1';
    action.textContent = loop.action > 0 ? '改正作用' : '改反作用';
  });
  cascades.forEach((casc, index) => {
    const card = wrap.querySelector(`[data-casc-card="${index}"]`);
    if (!card) return;
    card.querySelector(`[data-casc-state="${index}"]`).textContent = `${casc.outerManual ? '主环手动' : '主环自动'} / ${casc.innerManual ? '副环手动' : '副环自动'}`;
    setLoopCardReading(card, 'outerPv', cascadePvText(casc, 'outer'));
    setLoopCardReading(card, 'innerPv', cascadePvText(casc, 'inner'));
    setLoopCardInput(card, 'outerSp', number(casc.outerSp, 1));
    setLoopCardInput(card, 'outerKp', number(casc.outerKp, 3));
    setLoopCardInput(card, 'outerTi', tiText(casc.outerTi));
    setLoopCardInput(card, 'outerTd', number(casc.outerTd, 1));
    setLoopCardInput(card, 'innerKp', number(casc.innerKp, 3));
    setLoopCardInput(card, 'innerTi', tiText(casc.innerTi));
    setLoopCardInput(card, 'innerTd', number(casc.innerTd, 1));
    const outerAuto = card.querySelector(`[data-casc-auto="${index}"]`);
    const outerAction = card.querySelector(`[data-casc-action="${index}"]`);
    const innerAuto = card.querySelector(`[data-casc-inner-auto="${index}"]`);
    const innerAction = card.querySelector(`[data-casc-inner-action="${index}"]`);
    outerAuto.dataset.manual = casc.outerManual ? '0' : '1';
    outerAuto.textContent = casc.outerManual ? '主环投自动' : '主环投手动';
    outerAction.dataset.action = casc.outerAction > 0 ? '-1' : '1';
    outerAction.textContent = casc.outerAction > 0 ? '主环改正作用' : '主环改反作用';
    innerAuto.dataset.manual = casc.innerManual ? '0' : '1';
    innerAuto.textContent = casc.innerManual ? '副环投自动' : '副环投手动';
    innerAction.dataset.action = casc.innerAction > 0 ? '-1' : '1';
    innerAction.textContent = casc.innerAction > 0 ? '副环改正作用' : '副环改反作用';
  });
}

function renderLoops(state) {
  const wrap = $('loopCards');
  const loops = Array.isArray(state.loops) ? state.loops
    : (Array.isArray(state.loopParams) ? state.loopParams : []);
  const cascades = Number(state.mode || 0) === 1
    ? (Array.isArray(state.cascades) ? state.cascades
      : (Array.isArray(state.cascadeParams) ? state.cascadeParams : []))
    : [];
  if (!loops.length && !cascades.length) {
    if (wrap.dataset.signature !== 'empty') {
      wrap.dataset.signature = 'empty';
      wrap.innerHTML = '<div class="muted">暂未搭建回路。先在上方添加。应用参数后生效。</div>';
    }
    return;
  }
  const signature = loopStructureSignature(loops, cascades);
  if (wrap.dataset.signature === signature) {
    syncLoopCards(loops, cascades);
    return;
  }
  wrap.dataset.signature = signature;
  wrap.innerHTML = '';
  loops.forEach((loop, index) => {
    const div = document.createElement('div');
    div.className = 'loop-card';
    div.dataset.loopCard = String(index);
    const spUnit = pvCatalogItem(loop.pv).unit || '%';
    div.innerHTML = `
      <div class="loop-card-head">
        <div class="loop-card-title">
          <strong>单回路 ${index + 1}：${mvName(loop.mv)} → ${pvName(loop.pv)}</strong>
          <span class="loop-pv">PV <b data-reading="pv">${loopPvText(loop)}</b></span>
        </div>
        <span class="mini" data-loop-state="${index}">${loop.manual ? '手动' : '自动'} / ${loop.action > 0 ? '正作用' : '反作用'}</span>
      </div>
      <div class="field-grid">
        <label>SP ${spUnit}<input data-loop="${index}" data-field="sp" type="number" value="${number(loop.sp, 1)}"></label>
        <label>Kp<input data-loop="${index}" data-field="kp" type="number" step="0.01" value="${number(loop.kp, 3)}"></label>
        <label>Ti<input data-loop="${index}" data-field="ti" type="text" inputmode="decimal" placeholder="有限正数或 inf" value="${tiText(loop.ti)}"></label>
        <label>Td<input data-loop="${index}" data-field="td" type="number" step="1" value="${number(loop.td, 1)}"></label>
        <label>手动输出 %<input data-loop="${index}" data-field="manualOut" type="number" value="${number(loop.manualOut, 1)}"></label>
      </div>
      <div class="button-row">
        <button data-loop-apply="${index}" class="primary small-button">应用参数</button>
        <button data-loop-auto="${index}" data-manual="${loop.manual ? 0 : 1}">${loop.manual ? '投自动' : '投手动'}</button>
        <button data-loop-action="${index}" data-action="${loop.action > 0 ? -1 : 1}">${loop.action > 0 ? '改正作用' : '改反作用'}</button>
        <button data-loop-del="${index}" class="danger">删除</button>
      </div>`;
    wrap.appendChild(div);
  });
  cascades.forEach((casc, index) => {
    const div = document.createElement('div');
    div.className = 'loop-card';
    div.dataset.cascCard = String(index);
    const outerUnit = pvCatalogItem(casc.outer).unit || '%';
    div.innerHTML = `
      <div class="loop-card-head">
        <div class="loop-card-title">
          <strong>串级 ${index + 1}：${mvName(casc.mv)} → ${pvName(casc.inner)} → ${pvName(casc.outer)}</strong>
        </div>
        <span class="mini" data-casc-state="${index}">${casc.outerManual ? '主环手动' : '主环自动'} / ${casc.innerManual ? '副环手动' : '副环自动'}</span>
      </div>
      <div class="loop-pv-row">
        <span>主环 PV <b data-reading="outerPv">${cascadePvText(casc, 'outer')}</b></span>
        <span>副环 PV <b data-reading="innerPv">${cascadePvText(casc, 'inner')}</b></span>
      </div>
      <div class="field-grid">
        <label>主环 SP ${outerUnit}<input data-casc="${index}" data-field="outerSp" type="number" value="${number(casc.outerSp, 1)}"></label>
        <label>主环 Kp<input data-casc="${index}" data-field="outerKp" type="number" step="0.01" value="${number(casc.outerKp, 3)}"></label>
        <label>主环 Ti<input data-casc="${index}" data-field="outerTi" type="text" inputmode="decimal" placeholder="有限正数或 inf" value="${tiText(casc.outerTi)}"></label>
        <label>主环 Td<input data-casc="${index}" data-field="outerTd" type="number" value="${number(casc.outerTd, 1)}"></label>
        <label>副环 Kp<input data-casc="${index}" data-field="innerKp" type="number" step="0.01" value="${number(casc.innerKp, 3)}"></label>
        <label>副环 Ti<input data-casc="${index}" data-field="innerTi" type="text" inputmode="decimal" placeholder="有限正数或 inf" value="${tiText(casc.innerTi)}"></label>
        <label>副环 Td<input data-casc="${index}" data-field="innerTd" type="number" value="${number(casc.innerTd, 1)}"></label>
      </div>
      <div class="button-row">
        <button data-casc-apply="${index}" class="primary small-button">应用参数</button>
        <button data-casc-auto="${index}" data-manual="${casc.outerManual ? 0 : 1}">${casc.outerManual ? '主环投自动' : '主环投手动'}</button>
        <button data-casc-action="${index}" data-action="${casc.outerAction > 0 ? -1 : 1}">${casc.outerAction > 0 ? '主环改正作用' : '主环改反作用'}</button>
        <button data-casc-inner-auto="${index}" data-manual="${casc.innerManual ? 0 : 1}">${casc.innerManual ? '副环投自动' : '副环投手动'}</button>
        <button data-casc-inner-action="${index}" data-action="${casc.innerAction > 0 ? -1 : 1}">${casc.innerAction > 0 ? '副环改正作用' : '副环改反作用'}</button>
        <button data-casc-del="${index}" class="danger">删除</button>
      </div>`;
    wrap.appendChild(div);
  });
  wrap.querySelectorAll('[data-loop-apply]').forEach((btn) => {
    btn.onclick = () => applyLoop(Number(btn.dataset.loopApply)).catch((e) => toast(e.message, true));
  });
  wrap.querySelectorAll('[data-loop-auto]').forEach((btn) => {
    btn.onclick = () => applyLoopFlag(Number(btn.dataset.loopAuto), { manual: Number(btn.dataset.manual) }).catch((e) => toast(e.message, true));
  });
  wrap.querySelectorAll('[data-loop-action]').forEach((btn) => {
    btn.onclick = () => applyLoopFlag(Number(btn.dataset.loopAction), { action: Number(btn.dataset.action) }).catch((e) => toast(e.message, true));
  });
  wrap.querySelectorAll('[data-loop-del]').forEach((btn) => {
    btn.onclick = () => sendCommand(`LOOP_DEL ${Number(btn.dataset.loopDel)}`);
  });
  wrap.querySelectorAll('[data-casc-apply]').forEach((btn) => {
    btn.onclick = () => applyCascade(Number(btn.dataset.cascApply)).catch((e) => toast(e.message, true));
  });
  wrap.querySelectorAll('[data-casc-auto]').forEach((btn) => {
    btn.onclick = () => applyCascadeFlag(Number(btn.dataset.cascAuto), 'outer', { manual: Number(btn.dataset.manual) }).catch((e) => toast(e.message, true));
  });
  wrap.querySelectorAll('[data-casc-action]').forEach((btn) => {
    btn.onclick = () => applyCascadeFlag(Number(btn.dataset.cascAction), 'outer', { action: Number(btn.dataset.action) }).catch((e) => toast(e.message, true));
  });
  wrap.querySelectorAll('[data-casc-inner-auto]').forEach((btn) => {
    btn.onclick = () => applyCascadeFlag(Number(btn.dataset.cascInnerAuto), 'inner', { manual: Number(btn.dataset.manual) }).catch((e) => toast(e.message, true));
  });
  wrap.querySelectorAll('[data-casc-inner-action]').forEach((btn) => {
    btn.onclick = () => applyCascadeFlag(Number(btn.dataset.cascInnerAction), 'inner', { action: Number(btn.dataset.action) }).catch((e) => toast(e.message, true));
  });
  wrap.querySelectorAll('[data-casc-del]').forEach((btn) => {
    btn.onclick = () => sendCommand(`CASC_DEL ${Number(btn.dataset.cascDel)}`);
  });
  syncLoopCards(loops, cascades);
}

const PARAM_INPUT_SELECTOR = '.field-grid input,[data-loop][data-field],[data-casc][data-field]';

function inputValue(input, label) {
  const text = String(input?.value ?? '').trim();
  if (!text) throw new Error(`${label}不能为空`);
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`${label}必须是有效数字`);
  return value;
}

function tiInputValue(input, label) {
  const text = String(input?.value ?? '').trim().toLowerCase();
  if (text === 'inf' || text === '∞') return -1;
  const value = inputValue(input, label);
  if (value === 0) throw new Error(`${label}不能为 0；关闭积分请填 inf`);
  return value;
}

function markParameterDirty(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.matches(PARAM_INPUT_SELECTOR)) return;
  input.dataset.dirty = '1';
}

function clearParameterDirty(root = document) {
  root.querySelectorAll('input[data-dirty="1"]').forEach((input) => {
    delete input.dataset.dirty;
  });
}

function loopInput(index, field) {
  return document.querySelector(`[data-loop="${index}"][data-field="${field}"]`);
}

function cascInput(index, field) {
  return document.querySelector(`[data-casc="${index}"][data-field="${field}"]`);
}

function readLoopForm(index) {
  return {
    sp: inputValue(loopInput(index, 'sp'), 'SP'),
    kp: inputValue(loopInput(index, 'kp'), 'Kp'),
    ti: tiInputValue(loopInput(index, 'ti'), 'Ti'),
    td: inputValue(loopInput(index, 'td'), 'Td'),
    manualOut: inputValue(loopInput(index, 'manualOut'), '手动输出'),
  };
}

function readCascadeForm(index) {
  return {
    outerSp: inputValue(cascInput(index, 'outerSp'), '主环 SP'),
    outerKp: inputValue(cascInput(index, 'outerKp'), '主环 Kp'),
    outerTi: tiInputValue(cascInput(index, 'outerTi'), '主环 Ti'),
    outerTd: inputValue(cascInput(index, 'outerTd'), '主环 Td'),
    innerKp: inputValue(cascInput(index, 'innerKp'), '副环 Kp'),
    innerTi: tiInputValue(cascInput(index, 'innerTi'), '副环 Ti'),
    innerTd: inputValue(cascInput(index, 'innerTd'), '副环 Td'),
  };
}

function clearLoopDirty(index) {
  clearParameterDirty(document.querySelector(`[data-loop-card="${index}"]`) || document);
}

function clearCascadeDirty(index) {
  clearParameterDirty(document.querySelector(`[data-casc-card="${index}"]`) || document);
}

async function applyLoop(index) {
  const loop = app.state?.loops?.[index];
  if (!loop) return;
  const form = readLoopForm(index);
  if (Number(loop.sp) !== form.sp) await sendCommand(`SET_SP ${loop.pv} ${form.sp}`);
  await sendCommand(`SET_PID loop ${index} ${form.kp} ${form.ti} ${form.td} ${loop.action} ${loop.manual ? 1 : 0} ${form.manualOut}`);
  clearLoopDirty(index);
  toast('参数已应用');
}

async function applyLoopFlag(index, change) {
  const loop = app.state?.loops?.[index];
  if (!loop) return;
  const form = readLoopForm(index);
  const manual = change.manual === undefined ? (loop.manual ? 1 : 0) : change.manual;
  const action = change.action === undefined ? loop.action : change.action;
  await sendCommand(`SET_PID loop ${index} ${form.kp} ${form.ti} ${form.td} ${action} ${manual} ${form.manualOut}`);
  clearLoopDirty(index);
}

async function applyCascade(index) {
  const c = app.state?.cascades?.[index];
  if (!c) return;
  const form = readCascadeForm(index);
  if (Number(c.outerSp) !== form.outerSp) await sendCommand(`SET_PVX_SP ${c.outer} ${form.outerSp}`);
  await sendCommand(`SET_PID outer ${index} ${form.outerKp} ${form.outerTi} ${form.outerTd} ${c.outerAction} ${c.outerManual ? 1 : 0} ${c.outerOut}`);
  await sendCommand(`SET_PID inner ${index} ${form.innerKp} ${form.innerTi} ${form.innerTd} ${c.innerAction} ${c.innerManual ? 1 : 0} ${c.innerOut}`);
  clearCascadeDirty(index);
  toast('串级参数已应用');
}

async function applyCascadeFlag(index, which, change) {
  const c = app.state?.cascades?.[index];
  if (!c) return;
  const form = readCascadeForm(index);
  const inner = which === 'inner';
  const manual = change.manual === undefined
    ? ((inner ? c.innerManual : c.outerManual) ? 1 : 0)
    : change.manual;
  const action = change.action === undefined ? (inner ? c.innerAction : c.outerAction) : change.action;
  const kp = inner ? form.innerKp : form.outerKp;
  const ti = inner ? form.innerTi : form.outerTi;
  const td = inner ? form.innerTd : form.outerTd;
  const out = inner ? c.innerOut : c.outerOut;
  await sendCommand(`SET_PID ${inner ? 'inner' : 'outer'} ${index} ${kp} ${ti} ${td} ${action} ${manual} ${out}`);
  clearCascadeDirty(index);
}

function pvName(pv) {
  return modelSpec().pvNames[Number(pv)] || `PV${pv}`;
}
function mvName(mv) {
  const n = Number(mv);
  const names = modelSpec().mvNames || [];
  // 引擎 MV 编号含历史位号（如 FV1101/HV1102），不在下拉里也要能显示
  return names[n] || (modelSpec().modelId === 'hx' ? `MV${n}` : `FV${n}`);
}
// 指定模型的位号名：教师端一屏同时显示两个模型时必须用它。
function pvNameOf(modelId, pv) {
  const names = specOf(modelId).pvNames || [];
  return names[Number(pv)] || `PV${pv}`;
}
function mvNameOf(modelId, mv) {
  const names = specOf(modelId).mvNames || [];
  return names[Number(mv)] || `FV${mv}`;
}

function parameterModeText(mode) {
  return Number(mode) === 1 ? '串级' : '单回路';
}

function parameterRunningText(source) {
  if (!source?.running) return '未启动';
  return source.paused ? '暂停' : '运行中';
}

function singleLoopU(loop) {
  const sum = Number(loop?.pTerm || 0) + Number(loop?.iTerm || 0) + Number(loop?.dTerm || 0);
  return Number(loop?.uBias || 0) - Number(loop?.action || 1) * sum;
}

function systemParameterRows(state) {
  const rows = [
    ['项目', '数值'],
    ['实验模型', modelSpec().displayName],
    ['班级', app.me?.className || ''],
    ['学号 / 账号', app.me?.studentId || currentExportUser()],
    ['姓名', app.me?.name || (app.me?.role === 'teacher' ? '教师' : '')],
    ['导出时间', new Date().toLocaleString()],
    ['运行状态', parameterRunningText(state)],
    ['控制方案', parameterModeText(state.mode)],
    ['前馈偏置', state.bias ? '开' : '关'],
    ['仿真时间(s)', parameterNumber(state.sim_time, 1)],
  ];
  for (const tag of modelSpec().parameterTags || []) {
    rows.push([tag.label, parameterNumber(state[tag.key], tag.digits ?? 3)]);
  }
  return rows;
}

function loopParameterRows(state) {
  const rows = [[
    '序号', '类型', '被控对象', '执行对象', '回路状态', 'PV当前值', 'SP', 'Kp', 'Ti', 'Td',
    '作用', '控制方式', '偏差 e', 'P', 'I', 'D', 'u(t)', '实际输出', '手动输出',
  ]];
  const loops = Array.isArray(state.loops) ? state.loops : [];
  const cascades = Number(state.mode || 0) === 1 && Array.isArray(state.cascades) ? state.cascades : [];
  let sequence = 0;
  loops.forEach((loop) => {
    sequence += 1;
    rows.push([
      sequence,
      '单回路',
      pvName(loop.pv),
      mvName(loop.mv),
      loop.enabled === false ? '停用' : '投入',
      parameterNumber(loop.pvValue, 3),
      parameterNumber(loop.sp, 3),
      parameterNumber(loop.kp, 4),
      tiText(loop.ti),
      parameterNumber(loop.td, 2),
      Number(loop.action) > 0 ? '正作用' : '反作用',
      loop.manual ? '手动' : '自动',
      parameterNumber(loop.e, 4),
      parameterNumber(loop.pTerm, 4),
      parameterNumber(loop.iTerm, 4),
      parameterNumber(loop.dTerm, 4),
      parameterNumber(singleLoopU(loop), 4),
      parameterNumber(loop.out, 3),
      parameterNumber(loop.manualOut, 3),
    ]);
  });
  cascades.forEach((cascade, index) => {
    sequence += 1;
    rows.push([
      sequence,
      `串级 ${index + 1} 主环`,
      pvName(cascade.outer),
      pvName(cascade.inner),
      cascade.enabled === false ? '停用' : '投入',
      parameterNumber(cascade.outerPvValue, 3),
      parameterNumber(cascade.outerSp, 3),
      parameterNumber(cascade.outerKp, 4),
      tiText(cascade.outerTi),
      parameterNumber(cascade.outerTd, 2),
      Number(cascade.outerAction) > 0 ? '正作用' : '反作用',
      cascade.outerManual ? '手动' : '自动',
      parameterNumber(cascade.outerE, 4),
      parameterNumber(cascade.outerP, 4),
      parameterNumber(cascade.outerI, 4),
      parameterNumber(cascade.outerD, 4),
      parameterNumber(cascade.outerOut, 4),
      parameterNumber(cascade.outerOut, 3),
      '',
    ]);
    rows.push([
      sequence,
      `串级 ${index + 1} 副环`,
      pvName(cascade.inner),
      mvName(cascade.mv),
      cascade.enabled === false ? '停用' : '投入',
      parameterNumber(cascade.innerPvValue, 3),
      parameterNumber(cascade.outerOut, 3),
      parameterNumber(cascade.innerKp, 4),
      tiText(cascade.innerTi),
      parameterNumber(cascade.innerTd, 2),
      Number(cascade.innerAction) > 0 ? '正作用' : '反作用',
      cascade.innerManual ? '手动' : '自动',
      parameterNumber(cascade.innerE, 4),
      parameterNumber(cascade.innerP, 4),
      parameterNumber(cascade.innerI, 4),
      parameterNumber(cascade.innerD, 4),
      parameterNumber(cascade.innerOut, 4),
      parameterNumber(cascade.innerOut, 3),
      '',
    ]);
  });
  return rows;
}

function actuatorParameterRows(state) {
  const drivers = new Map();
  (Array.isArray(state.cascades) ? state.cascades : []).forEach((cascade) => {
    drivers.set(Number(cascade.mv), '串级占用');
  });
  (Array.isArray(state.loops) ? state.loops : []).forEach((loop) => {
    const mv = Number(loop.mv);
    if (!drivers.has(mv)) drivers.set(mv, loop.manual ? '回路手动' : '回路自动');
  });
  const targetByKey = new Map(manualTargets().map((target) => [target.key, target]));
  const rows = [['位号', '实际开度(%)', '指令开度(%)', '控制方式']];
  for (const item of modelSpec().actuatorReadouts || []) {
    const target = targetByKey.get(item.key);
    const value = Number(state[item.key] || 0);
    const mv = target?.pump ? null : Number(target?.mv);
    const driver = mv === null ? '手操' : drivers.get(mv);
    rows.push([
      item.label,
      parameterNumber(value, 3),
      parameterNumber(item.cmdKey ? state[item.cmdKey] : value, 3),
      driver || (value > 0.5 ? '手操' : '未用'),
    ]);
  }
  return rows;
}

function studentParameterSheets() {
  const state = app.state || {};
  return {
    system: systemParameterRows(state),
    loops: loopParameterRows(state),
    actuators: actuatorParameterRows(state),
  };
}

function exportStudentParameterCsv() {
  const sheets = studentParameterSheets();
  const rows = [
    [modelSpec().displayName + ' PID 参数汇总'],
    ['导出时间', new Date().toLocaleString()],
    [],
    ['系统状态'],
    ...sheets.system,
    [],
    ['回路参数'],
    ...sheets.loops,
    [],
    ['执行器状态'],
    ...sheets.actuators,
  ];
  const fileName = `${safeFilePart(modelSpec().displayName)}-${safeFilePart(currentExportUser())}-参数汇总-${localFileStamp()}.csv`;
  downloadTextFile(csvDocument(rows), fileName);
  toast('参数 CSV 已导出');
}

function exportStudentParameterExcel() {
  if (!window.XLSX) throw new Error('Excel 导出组件未加载，请刷新页面重试');
  const sheets = studentParameterSheets();
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheets.system), '系统状态');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheets.loops), '回路参数');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheets.actuators), '执行器状态');
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const fileName = `${safeFilePart(modelSpec().displayName)}-${safeFilePart(currentExportUser())}-参数汇总-${localFileStamp()}.xlsx`;
  downloadBlob(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName);
  toast('参数 Excel 已导出');
}

function teacherParameterRows() {
  const single = String(app.teacherModelFilter || 'all') !== 'all';
  const summary = single ? (modelSpec().teacherSummary || []) : [];
  const singleSpec = single ? modelSpec() : null;
  const headers = [
    '班级', '实验模型', '学号', '姓名', '仿真时间(s)', '状态', '方案', '前馈偏置',
    ...(single ? summary.map((item) => item.label) : ['关键测量']),
    '回路类型', '回路编号', '被控/主环', '副环/执行', 'PV当前值', 'SP', 'Kp', 'Ti', 'Td', '控制方式', '作用', '输出', '手动输出',
    ...(single
      ? (singleSpec.actuatorReadouts || []).flatMap((item) => [item.label + '实际', item.label + '指令'])
      : ['执行器(实际/指令)']),
  ];
  const rows = [headers];
  for (const session of filteredTeacherOverview()) {
    const modelId = session.modelId || 'tank';
    const rowSpec = specOf(modelId);
    const tags = session.tags || session;
    const summaryValues = single
      ? summary.map((item) => parameterNumber(tags[item.key], item.digits ?? 2))
      : [(rowSpec.teacherSummary || []).map((item) => item.label + '=' + parameterNumber(tags[item.key], item.digits ?? 2) + (item.unit || '')).join(' ')];
    const base = [
      session.className, modelDisplayNameOf(modelId), session.studentId, session.name, parameterNumber(session.simTime, 1), parameterRunningText(session),
      parameterModeText(session.mode), session.bias ? '开' : '关',
      ...summaryValues,
    ];
    const actuators = single
      ? (rowSpec.actuatorReadouts || []).flatMap((item) => [
        parameterNumber(tags[item.key], 2),
        parameterNumber(item.cmdKey ? tags[item.cmdKey] : tags[item.key], 2),
      ])
      : [(rowSpec.actuatorReadouts || []).map((item) => item.label + ' ' + parameterNumber(tags[item.key], 2) + '%/' + parameterNumber(item.cmdKey ? tags[item.cmdKey] : tags[item.key], 2) + '%').join(' ')];
    const loops = Array.isArray(session.loopParams) ? session.loopParams : [];
    const cascades = Array.isArray(session.cascadeParams) ? session.cascadeParams : [];
    let emitted = false;
    loops.forEach((loop, index) => {
      emitted = true;
      rows.push([...base,
        '单回路', index + 1, pvNameOf(modelId, loop.pv), mvNameOf(modelId, loop.mv), parameterNumber(loop.pvValue, 3), parameterNumber(loop.sp, 3),
        parameterNumber(loop.kp, 4), tiText(loop.ti), parameterNumber(loop.td, 2), loop.manual ? '手动' : '自动',
        Number(loop.action) > 0 ? '正作用' : '反作用', parameterNumber(loop.out, 3), parameterNumber(loop.manualOut, 3), ...actuators,
      ]);
    });
    cascades.forEach((cascade, index) => {
      emitted = true;
      rows.push([...base,
        `串级 ${index + 1} 主环`, index + 1, pvNameOf(modelId, cascade.outer), pvNameOf(modelId, cascade.inner), parameterNumber(cascade.outerPvValue, 3), parameterNumber(cascade.outerSp, 3),
        parameterNumber(cascade.outerKp, 4), tiText(cascade.outerTi), parameterNumber(cascade.outerTd, 2), cascade.outerManual ? '手动' : '自动',
        Number(cascade.outerAction) > 0 ? '正作用' : '反作用', parameterNumber(cascade.outerOut, 3), '', ...actuators,
      ]);
      rows.push([...base,
        `串级 ${index + 1} 副环`, index + 1, pvNameOf(modelId, cascade.inner), mvNameOf(modelId, cascade.mv), parameterNumber(cascade.innerPvValue, 3), parameterNumber(cascade.outerOut, 3),
        parameterNumber(cascade.innerKp, 4), tiText(cascade.innerTi), parameterNumber(cascade.innerTd, 2), cascade.innerManual ? '手动' : '自动',
        Number(cascade.innerAction) > 0 ? '正作用' : '反作用', parameterNumber(cascade.innerOut, 3), '', ...actuators,
      ]);
    });
    if (!emitted) {
      rows.push([...base, ...Array(13).fill(''), ...actuators]);
    }
  }
  return rows;
}

function exportTeacherParameterCsv() {
  const sessions = filteredTeacherOverview();
  if (!sessions.length) return toast('当前筛选范围没有在线学生');
  const fileName = `教师-${teacherModelLabel()}-筛选学生参数-${localFileStamp()}.csv`;
  downloadTextFile(csvDocument(teacherParameterRows()), fileName);
  toast(`已导出 ${sessions.length} 名学生的参数`);
}

function curveExportLabels() { return modelSpec().curveExportLabels || {}; }

function exportCurvePng(canvas, curve, group, owner, modelId) {
  if (!canvas) return toast('曲线画布不存在');
  const times = Array.isArray(curve?.history?.t) ? curve.history.t : [];
  if (!times.length) return toast('暂无可导出的曲线数据');
  const spec = specOf(modelId);
  const label = (spec.curveExportLabels || curveExportLabels())[group] || '曲线';
  const fileName = `${safeFilePart(spec.displayName)}-${safeFilePart(owner)}-${label}-${localFileStamp()}.png`;
  const finish = (blob) => {
    if (!blob) return toast('曲线图片生成失败');
    downloadBlob(blob, fileName);
    toast('曲线图片已导出');
  };
  if (canvas.toBlob) {
    canvas.toBlob(finish, 'image/png');
    return;
  }
  const link = document.createElement('a');
  link.href = canvas.toDataURL('image/png');
  link.download = fileName;
  link.click();
  toast('曲线图片已导出');
}

function exportStudentCurvePng() {
  const group = CURVE_DEFS[app.curve.active] ? app.curve.active : 'level';
  exportCurvePng($(CURVE_DEFS[group].canvasId), app.curve, group, currentExportUser(), activeModelId);
}

function exportTeacherCurvePng() {
  if (!app.selectedStudent) return toast('请先选择要查看的学生曲线');
  const group = teacherCurveDefs()[app.teacherCurve.active] ? app.teacherCurve.active : 'level';
  const owner = app.selectedStudent.studentId || app.selectedStudent.name || 'student';
  exportCurvePng($('teacherChart'), app.teacherCurve, group, owner, app.teacherCurve.modelId);
}

function cloudCurveViewSnapshot() {
  return JSON.parse(JSON.stringify({
    version: 1,
    active: app.curve.active,
    showAnnotation: app.curve.showAnnotation,
    annotationT: app.curve.annotationT,
    timeTag: app.curve.timeTag,
    ranges: app.curve.ranges,
    streams: {
      level: Array.from(app.streams.level),
      flow: Array.from(app.streams.flow),
      valve: Array.from(app.streams.valve),
    },
    flowYMax: app.flowYMax,
  }));
}

function renderCloudCurveImage(group) {
  const definition = CURVE_DEFS[group];
  if (!definition) return '';
  const snapshots = cloudCurveViewSnapshot();
  const curve = {
    history: app.history,
    showAnnotation: snapshots.showAnnotation,
    annotationT: snapshots.annotationT,
    timeTag: snapshots.timeTag,
    ranges: snapshots.ranges,
  };
  const visible = new Set(snapshots.streams[group] || []);
  const series = definition.series.filter((item) => visible.has(item.key));
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 520;
  const options = { group, unit: definition.unit, fixedYMax: definition.fixedYMax, curve };
  if (group !== 'flow') options.maxY = definition.fixedYMax;
  if (group === 'flow') {
    const flowLimit = normalizedFlowYMax(snapshots.flowYMax);
    if (flowLimit !== null) options.maxY = flowLimit;
  }
  drawChart(canvas, series, definition.yLabel, options);
  return canvas.toDataURL('image/png');
}

function cloudUploadAssets() {
  const images = {};
  for (const group of Object.keys(CURVE_DEFS)) images[group] = renderCloudCurveImage(group);
  return { curveView: cloudCurveViewSnapshot(), images };
}

function renderPidProcess(state) {
  const box = $('pidProcess');
  const loops = Array.isArray(state.loops) ? state.loops : [];
  const cascades = Number(state.mode || 0) === 1 && Array.isArray(state.cascades) ? state.cascades : [];
  if (!loops.length && !cascades.length) {
    box.className = 'pid-process empty';
    box.textContent = '暂未添加回路。添加回路后显示 PID 计算过程。';
    return;
  }
  box.className = 'pid-process';
  const parts = [];
  loops.forEach((p, i) => {
    const sum = Number(p.pTerm || 0) + Number(p.iTerm || 0) + Number(p.dTerm || 0);
    const u = Number(p.uBias || 0) - Number(p.action) * sum;
    parts.push(`<div class="pid-item">
      <h3>${mvName(p.mv)} → ${pvName(p.pv)}</h3>
      <div class="formula">e = SP - PV = ${number(p.e, 3)}<br>
        u(t) = ${number(p.uBias, 3)} - (${p.action > 0 ? '+1' : '-1'}) × (P + I + D) = ${number(u, 3)}%</div>
      <div class="term-grid"><span>P <b>${number(p.pTerm, 3)}</b></span><span>I <b>${number(p.iTerm, 3)}</b></span><span>D <b>${number(p.dTerm, 3)}</b></span><span>输出 <b>${number(p.out, 3)}%</b></span></div>
    </div>`);
  });
  cascades.forEach((p, i) => {
    parts.push(`<div class="pid-item">
      <h3>串级 ${i + 1}：${mvName(p.mv)}</h3>
      <div class="formula">主环 ${pvName(p.outer)}：e=${number(p.outerE, 3)}，P=${number(p.outerP, 3)}，I=${number(p.outerI, 3)}，D=${number(p.outerD, 3)}<br>
        副环 ${pvName(p.inner)}：e=${number(p.innerE, 3)}，P=${number(p.innerP, 3)}，I=${number(p.innerI, 3)}，D=${number(p.innerD, 3)}</div>
      <div class="term-grid"><span>主环输出 <b>${number(p.outerOut, 3)}%</b></span><span>副环输出 <b>${number(p.innerOut, 3)}%</b></span></div>
    </div>`);
  });
  box.innerHTML = parts.join('');
}

function renderScore(state) {
  const s = state.score || {};
  const mode = Number(s.mode || 0);
  const labels = scoreLabels();
  const modeText = mode === 1 ? (labels.mode1 || '单对象评分') : (labels.mode2 || '系统评分');
  $('scoreTitle').textContent = mode === 0 ? '评分未开始' : `${modeText}${s.finished ? '：已结束' : s.active ? '：进行中' : ''}`;
  $('scoreSubtitle').textContent = s.active
    ? `评分时间 ${number(s.sessionT, 0)} s`
    : (s.finished ? '评分已结束，可查看结果。' : (mode ? '评分方案已选择，点击“开始评分”后开始计时。' : '请先选择评分方案，再点击“开始评分”。'));
  $('scoreTotal').textContent = number(s.total, 1);
  $('scoreOp').textContent = number(s.operation, 1);
  $('scoreCtrl').textContent = number(s.control, 1);
  { const el = $('scoreTarget'); if (el) el.textContent = number(s.target, 1); }
  $('scoreSafe').textContent = number(s.safety, 1);
  $('scoreBenefit').textContent = number(s.benefit, 1);
  const finished = !!s.finished;
  if (finished && !app.scoreEndAt) ensureScoreEnd();
  if (!finished) app.scoreEndAt = null;
  const endEl = $('scoreEndTime');
  if (finished && app.scoreEndAt) {
    endEl.textContent = `评分结束时间 ${new Date(app.scoreEndAt).toLocaleString()}`;
    endEl.classList.remove('hidden');
  } else {
    endEl.classList.add('hidden');
  }
  document.querySelectorAll('[data-score-tank]').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.scoreTank) === Number(s.tank || 0));
  });
  $('scoreTargetRow').classList.toggle('hidden', mode !== 1);
  const rows = (labels.rowLabels || []).map((name, i) => {
    const t = state.tanks?.[i] || {};
    return '<tr>' + (labels.columns || []).map((column) => {
      let value;
      if (column.key === 'name') value = name;
      else if (column.key === 'settle') value = t.settled ? number(t.settle, column.digits ?? 1) : '-';
      else value = number(t[column.key], column.digits ?? 2);
      return '<td>' + value + '</td>';
    }).join('') + '</tr>';
  });
  $('tankScoreRows').innerHTML = rows.join('');
}

// 评分结束后显示结束时间；刷新页面时从服务器记录里取回。
async function ensureScoreEnd() {
  if (app.scoreEndAt || app.scoreEndFetching) return;
  app.scoreEndFetching = true;
  try {
    const data = await api('/api/score-record');
    if (data.record && data.record.endedAt) {
      app.scoreEndAt = data.record.endedAt;
      renderScore(app.state);
    }
  } catch {
    app.scoreEndFetching = false;
  }
}


function resetHistoryClock(history = app.history, rawTime = app.state?.sim_time) {
  const lastDisplay = Number(history?.t?.[history.t.length - 1]);
  const raw = Number(rawTime);
  const hasDisplay = Number.isFinite(lastDisplay);
  const hasRaw = Number.isFinite(raw);
  app.historyClock = {
    offset: hasDisplay && hasRaw && lastDisplay >= raw ? lastDisplay - raw : 0,
    lastRawT: hasRaw ? raw : null,
    lastDisplayT: hasDisplay ? lastDisplay : (hasRaw ? raw : null),
  };
}

function displayHistoryTime(rawTime) {
  const rawT = Number(rawTime);
  if (!Number.isFinite(rawT)) return 0;
  if (!Number.isFinite(app.historyClock.lastRawT)) {
    resetHistoryClock(app.history, rawT);
  } else if (rawT + 1e-9 < app.historyClock.lastRawT) {
    const lastDisplay = Number(app.historyClock.lastDisplayT);
    app.historyClock.offset = Math.max(app.historyClock.offset, (Number.isFinite(lastDisplay) ? lastDisplay : rawT) + 0.1 - rawT);
  }
  const displayT = rawT + app.historyClock.offset;
  app.historyClock.lastRawT = rawT;
  app.historyClock.lastDisplayT = displayT;
  return displayT;
}

function appendHistory(state) {
  if (!state) return;
  if (!Array.isArray(app.history.t)) app.history = { t: [] };
  const t = displayHistoryTime(state.sim_time);
  const previous = app.history.t[app.history.t.length - 1];
  const fields = modelHistoryKeys().filter((key) => key !== 't');
  if (t === previous && app.history.t.length) {
    app.history.t[app.history.t.length - 1] = t;
    fields.forEach((key) => {
      if (!app.history[key]) app.history[key] = [];
      app.history[key][app.history[key].length - 1] = Number(state[key] || 0);
    });
  } else {
    app.history.t.push(t);
    fields.forEach((key) => {
      if (!app.history[key]) app.history[key] = [];
      app.history[key].push(Number(state[key] || 0));
    });
  }
  if (app.history.t.length > 1800) {
    Object.keys(app.history).forEach((key) => app.history[key].splice(0, app.history[key].length - 1800));
  }
}

function normalizedFlowYMax(value, modelId) {
  const n = Number(value);
  const limit = modelId ? (Number(specOf(modelId).flowYLimit) || 100) : flowYLimit();
  return Number.isFinite(n) && n > 0 ? clamp(n, 1, limit) : null;
}

function chartSeries(keys, colors = []) {
  return keys.map((key, index) => {
    const item = CURVE_SERIES_INDEX.get(key);
    return item ? { ...item } : { key, label: key, color: colors[index] || '#e8f0f6' };
  });
}

const curveDrawPending = { value: false };
// curve interaction helpers

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function niceStep(range, ticks = 5) {
  if (!Number.isFinite(range) || range <= 0 || ticks < 1) return 1;
  const raw = range / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

function roundRectPath(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function nearestTimeIndex(times, t) {
  if (!times.length) return -1;
  let lo = 0, hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (Number(times[mid]) < t) lo = mid; else hi = mid;
  }
  return Math.abs(Number(times[lo]) - t) <= Math.abs(Number(times[hi]) - t) ? lo : hi;
}

function curveAutoYMax(curve, group, times, series) {
  const data = curve.history || {};
  let maxValue = 1;
  for (const item of series) {
    const arr = data[item.key] || [];
    for (let i = 0; i < times.length; i++) maxValue = Math.max(maxValue, Number(arr[i]) || 0);
  }
  if (group === 'flow') return Math.min(flowYLimit(), Math.max(1, Math.ceil(maxValue * 1.2 * 2) / 2));
  return maxValue * 1.12;
}

function curveRange(curve, group, times, series, options) {
  const range = curve.ranges[group];
  const tEnd = times.length ? Number(times[times.length - 1]) : 0;
  const fullX = Math.max(30, tEnd * 1.05);
  if (!Number.isFinite(range.x0) || !Number.isFinite(range.x1)) {
    range.x0 = 0;
    range.x1 = fullX;
    range.follow = true;
  }
  if (range.follow) {
    const span = Math.max(1, range.x1 - range.x0);
    range.x1 = fullX;
    range.x0 = Math.max(0, range.x1 - span);
  }
  const fullY = Number.isFinite(Number(options.maxY)) && Number(options.maxY) > 0
    ? Number(options.maxY)
    : curveAutoYMax(curve, group, times, series);
  if (!Number.isFinite(range.y1) || range.y1 <= range.y0) {
    range.y0 = 0;
    range.y1 = group === 'level' || group === 'valve' ? 100 : fullY;
  }
  range.x0 = clamp(range.x0, 0, Math.max(0, fullX - 1));
  range.x1 = clamp(range.x1, range.x0 + 1, fullX);
  range.y0 = clamp(range.y0, 0, Math.max(0, fullY - 0.5));
  range.y1 = clamp(range.y1, range.y0 + 0.5, fullY);
  return { ...range, fullX, fullY, tEnd };
}

function curveFullRange(curve, group, options = {}) {
  const data = curve.history || {};
  const times = Array.isArray(data.t) ? data.t : [];
  const series = options.series || CURVE_DEFS[group]?.series || [];
  const tEnd = times.length ? Number(times[times.length - 1]) : 0;
  const fullX = Math.max(30, tEnd * 1.05);
  const fixedYMax = Number(options.fixedYMax ?? CURVE_DEFS[group]?.fixedYMax);
  const fullY = group === 'flow' && Number.isFinite(Number(options.maxY))
    ? Number(options.maxY)
    : (Number.isFinite(fixedYMax) ? fixedYMax : curveAutoYMax(curve, group, times, series));
  return { fullX, fullY };
}

function clampCurveRange(group, range, fullX, fullY) {
  const minSpanX = Math.min(1, fullX);
  const minSpanY = Math.min(0.5, fullY);
  let spanX = Math.max(minSpanX, Number(range.x1) - Number(range.x0));
  let spanY = Math.max(minSpanY, Number(range.y1) - Number(range.y0));
  spanX = Math.min(spanX, fullX);
  spanY = Math.min(spanY, fullY);
  range.x0 = clamp(Number(range.x0), 0, Math.max(0, fullX - spanX));
  range.x1 = clamp(range.x0 + spanX, range.x0 + minSpanX, fullX);
  range.y0 = clamp(Number(range.y0), 0, Math.max(0, fullY - spanY));
  range.y1 = clamp(range.y0 + spanY, range.y0 + minSpanY, fullY);
  return range;
}

function drawChart(canvas, series, yLabel, options = {}) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(320, Math.round(rect.width || canvas.width));
  const h = Math.max(300, Math.round(rect.height || canvas.height));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelW = Math.round(w * dpr);
  const pixelH = Math.round(h * dpr);
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#091016';
  ctx.fillRect(0, 0, w, h);

  const curve = options.curve || app.curve;
  const data = curve.history || {};
  const times = Array.isArray(data.t) ? data.t : [];
  if (!times.length) {
    ctx.fillStyle = '#8fa4b5';
    ctx.font = '16px sans-serif';
    ctx.fillText(options.emptyText || '等待仿真数据...', 24, 42);
    canvas._curveLayout = null;
    return;
  }

  const group = options.group || 'level';
  const range = curveRange(curve, group, times, series, options);
  const pad = { l: 66, r: 26, t: 42, b: 46 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const left = pad.l, right = pad.l + plotW, top = pad.t, bottom = pad.t + plotH;
  const xOf = (t) => left + ((t - range.x0) / (range.x1 - range.x0)) * plotW;
  const yOf = (v) => bottom - ((v - range.y0) / (range.y1 - range.y0)) * plotH;

  ctx.fillStyle = '#0b1117';
  ctx.fillRect(left, top, plotW, plotH);
  ctx.font = '12px sans-serif';
  const yStep = niceStep(range.y1 - range.y0, 5);
  for (let v = Math.ceil(range.y0 / yStep) * yStep; v <= range.y1 + 1e-9; v += yStep) {
    const y = yOf(v);
    ctx.strokeStyle = '#1f303d';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.fillStyle = '#8297a9';
    ctx.textAlign = 'right';
    const digits = group === 'flow' ? 2 : 0;
    ctx.fillText(Number(v).toFixed(digits), left - 9, y + 4);
  }
  const xStep = niceStep(range.x1 - range.x0, 6);
  for (let v = Math.ceil(range.x0 / xStep) * xStep; v <= range.x1 + 1e-9; v += xStep) {
    const x = xOf(v);
    ctx.strokeStyle = '#1f303d';
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.fillStyle = '#8297a9';
    ctx.textAlign = 'center';
    ctx.fillText(Number(v).toFixed(0), x, bottom + 21);
  }
  ctx.strokeStyle = '#5a7485';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(left, top, plotW, plotH);
  ctx.fillStyle = '#91a8b8';
  ctx.textAlign = 'left';
  ctx.fillText(yLabel, 10, 22);
  ctx.textAlign = 'right';
  ctx.fillText('t / s', right, h - 10);
  ctx.textAlign = 'center';
  const title = `${group === 'level' ? '液位响应曲线' : group === 'flow' ? '流量曲线' : '开度曲线'}   |   t ${range.x0.toFixed(0)}~${range.x1.toFixed(0)} s   |   Y ${range.y0.toFixed(group === 'flow' ? 2 : 1)}~${range.y1.toFixed(group === 'flow' ? 2 : 1)} ${options.unit || ''}`;
  ctx.fillStyle = '#d7e3ec';
  ctx.font = '600 13px sans-serif';
  ctx.fillText(title, w / 2, 22);

  const maxSegments = Math.max(500, Math.min(1600, Math.floor(plotW * 1.35)));
  const stride = Math.max(1, Math.ceil(times.length / maxSegments));
  ctx.save();
  ctx.beginPath(); ctx.rect(left, top, plotW, plotH); ctx.clip();
  for (const item of series) {
    const arr = data[item.key] || [];
    ctx.strokeStyle = item.color;
    ctx.lineWidth = item.dash ? 1.4 : 2;
    if (item.dash) ctx.setLineDash([6, 5]); else ctx.setLineDash([]);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < times.length; i += stride) {
      const x = xOf(Number(times[i]));
      const y = yOf(Number(arr[i] || 0));
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    const last = times.length - 1;
    if (last >= 0 && last % stride !== 0) ctx.lineTo(xOf(Number(times[last])), yOf(Number(arr[last] || 0)));
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();

  const layout = { group, canvas, left, right, top, bottom, plotW, plotH, x0: range.x0, x1: range.x1, y0: range.y0, y1: range.y1, fullX: range.fullX, fullY: range.fullY, series, times, lineX: null, tagRect: null };
  if (curve.showAnnotation && series.length) {
    let annotationT = Number(curve.annotationT);
    if (!Number.isFinite(annotationT)) annotationT = range.x0 + (range.x1 - range.x0) * 0.7;
    if (annotationT < range.x0 || annotationT > range.x1) annotationT = range.x0 + (range.x1 - range.x0) * 0.7;
    curve.annotationT = annotationT;
    const idx = nearestTimeIndex(times, annotationT);
    const actualT = Number(times[idx]);
    const lineX = xOf(actualT);
    layout.lineX = lineX;
    layout.range = range;
    layout.labelRects = [];
    ctx.save();
    ctx.strokeStyle = 'rgba(38, 205, 175, .92)';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(lineX, top); ctx.lineTo(lineX, bottom); ctx.stroke();
    ctx.setLineDash([]);
    const labels = series.map((item) => {
      const value = Number((data[item.key] || [])[idx] || 0);
      return { item, value, y: clamp(yOf(value), top + 10, bottom - 10) };
    }).sort((a, b) => a.y - b.y);
    let lastBottom = top + 2;
    for (const label of labels) {
      const digits = group === 'flow' ? 2 : 1;
      const suffix = group === 'level' ? '%FS' : group === 'flow' ? 'L/min' : '%';
      const text = `${label.item.label} ${label.value.toFixed(digits)} ${suffix}`;
      ctx.font = '11px sans-serif';
      const boxW = ctx.measureText(text).width + 16;
      let boxX = lineX + 10;
      if (boxX + boxW > right - 2) boxX = lineX - boxW - 10;
      boxX = clamp(boxX, left + 2, right - boxW - 2);
      let boxY = Math.max(label.y - 10, lastBottom + 3);
      boxY = clamp(boxY, top + 2, bottom - 20);
      lastBottom = boxY + 19;
      layout.labelRects.push({ x: boxX, y: boxY, w: boxW, h: 19 });
      roundRectPath(ctx, boxX, boxY, boxW, 19, 5);
      ctx.fillStyle = 'rgba(13, 23, 31, .94)';
      ctx.fill();
      ctx.strokeStyle = label.item.color;
      ctx.lineWidth = 1.2; ctx.stroke();
      ctx.fillStyle = '#e7f0f6'; ctx.textAlign = 'left';
      ctx.fillText(text, boxX + 8, boxY + 13);
    }
    let tagX = curve.timeTag.moved ? Number(curve.timeTag.x) : (lineX - 91 >= left + 3 ? lineX - 91 : lineX + 9);
    let tagY = curve.timeTag.moved ? Number(curve.timeTag.y) : top + 8;
    const tagW = 82, tagH = 22;
    if (!Number.isFinite(tagX)) tagX = lineX - 91 >= left + 3 ? lineX - 91 : lineX + 9;
    if (!Number.isFinite(tagY)) tagY = top + 8;
    tagX = clamp(tagX, left + 3, right - tagW - 3);
    tagY = clamp(tagY, top + 3, bottom - tagH - 3);
    layout.tagRect = { x: tagX, y: tagY, w: tagW, h: tagH };
    roundRectPath(ctx, tagX, tagY, tagW, tagH, 5);
    ctx.fillStyle = 'rgba(22, 40, 55, .96)'; ctx.fill();
    ctx.strokeStyle = '#28b8a7'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = '#e7f0f6'; ctx.textAlign = 'center'; ctx.font = '11px sans-serif';
    ctx.fillText(`t = ${actualT.toFixed(1)} s`, tagX + tagW / 2, tagY + 15);
    ctx.restore();
  }
  canvas._curveLayout = layout;
}


function scheduleStudentCharts() {
  if (app.view !== 'curves' || !app.state || curveDrawPending.value) return;
  curveDrawPending.value = true;
  requestAnimationFrame(() => {
    curveDrawPending.value = false;
    drawStudentCharts();
  });
}

function scheduleCurveDraw(curve = app.curve) {
  if (curve === app.teacherCurve) {
    if (app.view !== 'teacher' || !app.selectedStudent || curve._drawPending) return;
    curve._drawPending = true;
    requestAnimationFrame(() => {
      curve._drawPending = false;
      drawTeacherChart();
    });
    return;
  }
  scheduleStudentCharts();
}

function drawStudentCharts() {
  curveDrawPending.value = false;
  if (!app.state || app.view !== 'curves') return;
  const group = CURVE_DEFS[app.curve.active] ? app.curve.active : 'level';
  const definition = CURVE_DEFS[group];
  const series = definition.series.filter((item) => app.streams[group].has(item.key));
  const options = { group, unit: definition.unit, fixedYMax: definition.fixedYMax, curve: app.curve };
  if (group !== 'flow') options.maxY = definition.fixedYMax;
  if (group === 'flow') {
    const flowLimit = normalizedFlowYMax(app.flowYMax);
    if (flowLimit !== null) options.maxY = flowLimit;
  }
  drawChart($(definition.canvasId), series, definition.yLabel, options);
  syncLegend();
}

function currentHistoryKeys() {
  return app.history;
}

// 图例按钮与曲线显隐状态保持同步。
function seriesGroup(key, curve = app.curve) {
  const streams = curve.streams || app.streams;
  const group = CURVE_SERIES_GROUP.get(key);
  if (group && streams[group]) return streams[group];
  return streams.valve || new Set();
}

function syncLegend() {
  document.querySelectorAll('.legend button[data-series]').forEach((btn) => {
    btn.classList.toggle('active', seriesGroup(btn.dataset.series).has(btn.dataset.series));
  });
}

function switchCurveTab(group) {
  const next = CURVE_DEFS[group] ? group : 'level';
  app.curve.active = next;
  document.querySelectorAll('[data-curve-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.curveTab === next);
  });
  document.querySelectorAll('[data-curve-stage]').forEach((stage) => {
    stage.classList.toggle('active', stage.dataset.curveStage === next);
  });
  scheduleStudentCharts();
}

function resetCurveView(group = app.curve.active, curve = app.curve) {
  const range = curve.ranges[group];
  if (!range) return;
  range.x0 = null;
  range.x1 = null;
  range.y0 = 0;
  range.y1 = group === 'flow' ? null : CURVE_DEFS[group].fixedYMax;
  range.follow = true;
  curve.annotationT = null;
  curve.timeTag.moved = false;
  scheduleCurveDraw(curve);
}

function syncAnnotationButton(buttonId = 'annToggleBtn', curve = app.curve) {
  const button = $(buttonId);
  if (!button) return;
  button.textContent = curve.showAnnotation ? '隐藏标注' : '显示标注';
  button.classList.toggle('primary', curve.showAnnotation);
  button.setAttribute('aria-pressed', curve.showAnnotation ? 'false' : 'true');
}

function curvePoint(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function pointInRect(point, rect) {
  return rect && point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}

function beginCurveInteraction(event) {
  if (event.button !== 0) return;
  const canvas = event.currentTarget;
  const curve = canvas._curveContext || app.curve;
  const layout = canvas._curveLayout;
  if (!layout) return;
  const point = curvePoint(canvas, event);
  const { left, right, top, bottom } = layout;
  let mode = null;
  if (curve.showAnnotation && pointInRect(point, layout.tagRect)) mode = 'timeTag';
  else if (curve.showAnnotation && Number.isFinite(layout.lineX)
    && Math.abs(point.x - layout.lineX) <= 8 && point.y >= top - 5 && point.y <= bottom + 5) mode = 'annotation';
  else if (point.x >= left - 34 && point.x <= right && point.y >= bottom - 6 && point.y <= bottom + 38) mode = 'xAxis';
  else if (point.x >= left - 78 && point.x <= left + 10 && point.y >= top - 26 && point.y <= bottom + 26) mode = 'yAxis';
  else if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) {
    const hitLabel = (layout.labelRects || []).some((rect) => pointInRect(point, rect));
    if (!hitLabel) mode = 'plot';
  }
  if (!mode) return;
  const range = curve.ranges[layout.group];
  if (!range) return;
  curve.drag = {
    mode,
    group: layout.group,
    canvas,
    layout,
    startX: point.x,
    startY: point.y,
    startRange: { x0: Number(range.x0), x1: Number(range.x1), y0: Number(range.y0), y1: Number(range.y1) },
  };
  canvas.classList.add('dragging');
  try { canvas.setPointerCapture(event.pointerId); } catch {}
  event.preventDefault();
}

function updateCurveCursor(event) {
  const canvas = event.currentTarget;
  const curve = canvas._curveContext || app.curve;
  if (curve.drag) return;
  const layout = canvas._curveLayout;
  if (!layout) {
    canvas.classList.remove('axis-x', 'axis-y', 'plot-ready');
    return;
  }
  const point = curvePoint(canvas, event);
  const { left, right, top, bottom } = layout;
  const xAxis = point.x >= left - 34 && point.x <= right && point.y >= bottom - 6 && point.y <= bottom + 38;
  const yAxis = point.x >= left - 78 && point.x <= left + 10 && point.y >= top - 26 && point.y <= bottom + 26;
  canvas.classList.toggle('axis-x', xAxis && !yAxis);
  canvas.classList.toggle('axis-y', yAxis);
  canvas.classList.toggle('plot-ready', !xAxis && !yAxis && point.x >= left && point.x <= right && point.y >= top && point.y <= bottom);
}

function moveCurveInteraction(event) {
  const canvas = event.currentTarget;
  const curve = canvas._curveContext || app.curve;
  const drag = curve.drag;
  if (!drag || drag.canvas !== canvas) return;
  const point = curvePoint(drag.canvas, event);
  const layout = drag.layout;
  const range = curve.ranges[drag.group];
  if (!range) return;
  const start = drag.startRange;
  if (drag.mode === 'xAxis') {
    const dx = point.x - drag.startX;
    const delta = dx / Math.max(10, layout.plotW) * layout.fullX * 0.35;
    range.x0 = start.x0 + delta;
    range.x1 = start.x1 - delta;
    range.follow = false;
    clampCurveRange(drag.group, range, layout.fullX, Math.max(layout.fullY, start.y1));
    scheduleCurveDraw(curve);
    return;
  }
  if (drag.mode === 'yAxis') {
    const dy = point.y - drag.startY;
    const delta = -dy / Math.max(10, layout.plotH) * layout.fullY * 0.35;
    range.y0 = 0;
    range.y1 = start.y1 - delta;
    range.follow = false;
    clampCurveRange(drag.group, range, layout.fullX, layout.fullY);
    scheduleCurveDraw(curve);
    return;
  }
  if (drag.mode === 'annotation') {
    const t = start.x0 + clamp((point.x - layout.left) / Math.max(1, layout.plotW), 0, 1) * (start.x1 - start.x0);
    curve.annotationT = clamp(t, start.x0, start.x1);
    range.follow = false;
    scheduleCurveDraw(curve);
    return;
  }
  if (drag.mode === 'timeTag') {
    curve.timeTag.moved = true;
    curve.timeTag.x = clamp(point.x - 41, layout.left + 3, layout.right - 85);
    curve.timeTag.y = clamp(point.y - 11, layout.top + 3, layout.bottom - 25);
    scheduleCurveDraw(curve);
    return;
  }
  if (drag.mode === 'plot') {
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    const xShift = -(dx / Math.max(10, layout.plotW)) * layout.fullX * 0.35;
    const yShift = (dy / Math.max(10, layout.plotH)) * layout.fullY * 0.35;
    range.x0 = start.x0 + xShift;
    range.x1 = start.x1 + xShift;
    range.y0 = start.y0 + yShift;
    range.y1 = start.y1 + yShift;
    range.follow = false;
    clampCurveRange(drag.group, range, layout.fullX, layout.fullY);
    scheduleCurveDraw(curve);
  }
}

function endCurveInteraction(event) {
  const canvas = event.currentTarget;
  const curve = canvas._curveContext || app.curve;
  const drag = curve.drag;
  if (!drag) return;
  drag.canvas.classList.remove('dragging');
  drag.canvas.classList.remove('axis-x', 'axis-y', 'plot-ready');
  try { drag.canvas.releasePointerCapture(event.pointerId); } catch {}
  curve.drag = null;
}

function wireCurveInteraction(canvas, curve = app.curve) {
  canvas._curveContext = curve;
  canvas.addEventListener('pointerdown', beginCurveInteraction);
  canvas.addEventListener('pointermove', moveCurveInteraction);
  canvas.addEventListener('pointerup', endCurveInteraction);
  canvas.addEventListener('pointercancel', endCurveInteraction);
  canvas.addEventListener('pointerleave', updateCurveCursor);
  canvas.addEventListener('lostpointercapture', endCurveInteraction);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('dblclick', () => resetCurveView(canvas._curveLayout?.group || curve.active, curve));
}

async function clearCurveHistory() {
  if (!confirm('确定清空全部历史曲线吗？仿真状态不会改变。')) return;
  try {
    await api('/api/curve-clear', { method: 'POST', body: '{}' });
  } catch (error) {
    toast(error.message || '清空曲线失败');
    return;
  }
  app.history = { t: [] };
  const rawT = Number(app.state?.sim_time);
  app.historyClock = {
    offset: Number.isFinite(rawT) ? -rawT : 0,
    lastRawT: Number.isFinite(rawT) ? rawT : null,
    lastDisplayT: 0,
  };
  Object.values(app.curve.ranges).forEach((range) => {
    range.x0 = null;
    range.x1 = null;
    range.follow = true;
  });
  app.curve.annotationT = null;
  app.curve.timeTag = { x: null, y: null, moved: false };
  scheduleStudentCharts();
  toast('历史曲线已清空');
}

function wireCurveControls() {
  document.querySelectorAll('[data-curve-tab]').forEach((button) => {
    button.onclick = () => switchCurveTab(button.dataset.curveTab);
  });
  $('curveLatestBtn').onclick = () => resetCurveView();
  $('curveExportBtn').onclick = () => exportStudentCurvePng();
  $('annToggleBtn').onclick = () => {
    app.curve.showAnnotation = !app.curve.showAnnotation;
    syncAnnotationButton();
    scheduleStudentCharts();
  };
  $('curveClearBtn').onclick = () => clearCurveHistory();
  document.querySelectorAll('.curve-stage .legend button[data-series]').forEach((button) => {
    button.onclick = () => {
      const key = button.dataset.series;
      const stream = seriesGroup(key);
      if (stream.has(key)) stream.delete(key); else stream.add(key);
      syncLegend();
      drawStudentCharts();
    };
  });
  document.querySelectorAll('.curve-stage .curve-canvas').forEach((canvas) => wireCurveInteraction(canvas, app.curve));
  window.addEventListener('resize', () => {
    applySimScale();
    renderProcessWires();
    if (app.view === 'curves') scheduleStudentCharts();
    if (app.view === 'teacher' && app.selectedStudent) drawTeacherChart();
  }, { passive: true });
  syncAnnotationButton();
}


function cloudTime(value) {
  if (!value) return '无';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function selectedProjectMeta() {
  return (app.cloudProjects || []).find((item) => Number(item.slot) === Number(app.projectSlot)) || null;
}

function renderStudentCloudStatus() {
  const allowed = app.me?.role === 'teacher' || !!app.cloudSettings.allowStudentUpload;
  const slotSelect = $('projectSlot');
  if (slotSelect) slotSelect.value = String(app.projectSlot);
  const saveCurrent = $('currentSaveBtn');
  const restoreCurrent = $('currentRestoreBtn');
  const upload = $('cloudUploadBtn');
  const restore = $('cloudRestoreBtn');
  const exportButton = $('projectExportBtn');
  const project = selectedProjectMeta();
  const hasProject = !!project && !project.empty;
  const hasCurrent = !!app.currentState;
  const paused = simulationPaused();
  // H1 整改：运行中且未暂停才禁止保存；冷态（未启动）与暂停都可以保存。
  const live = !!app.state?.running && !app.state?.paused;
  if (saveCurrent) {
    saveCurrent.disabled = live;
    saveCurrent.title = live
      ? '请先暂停仿真，再保存当前状态'
      : (app.state?.running ? '保存当前暂停状态' : '保存当前配置（未启动）');
  }
  if (restoreCurrent) {
    restoreCurrent.disabled = !(hasCurrent || app.cloudRecovery);
    restoreCurrent.title = hasCurrent ? '恢复上传保存状态' : (app.cloudRecovery ? '恢复最近自动保存' : '没有可恢复的状态');
  }
  if (upload) {
    upload.disabled = !paused; // 学生 2/3/4 自由上传；云端1导出云端才受教师开关
    upload.classList.toggle('on', allowed && paused);
    upload.title = !allowed
      ? '教师尚未开放云端上传功能'
      : (paused ? `上传当前状态到云端方案 ${app.projectSlot}` : '请先暂停仿真，再上传云端');
  }
  if (restore) restore.disabled = !hasProject;
  if (exportButton) {
    exportButton.disabled = live;
    exportButton.title = live
      ? '请先暂停仿真，再导出工程'
      : (app.state?.running ? '导出当前暂停状态' : '导出当前配置（未启动）');
  }
  const line = $('cloudStateLine');
  if (!line) return;
  const currentText = hasCurrent ? `已保存 ${cloudTime(app.currentState.savedAt)}` : '未保存';
  const cloudText = hasProject ? `已上传 ${cloudTime(project.savedAt || project.uploadedAt)}` : '空';
  const permissionText = allowed ? '可上传' : '云端上传已关闭';
  const recoveryText = app.cloudRecovery ? `；自动保存 ${cloudTime(app.cloudRecovery.savedAt)}` : '';
  line.textContent = `当前状态：${currentText}；方案 ${app.projectSlot}：${cloudText}（${permissionText}）${recoveryText}`;
}

async function refreshStudentCloudStatus() {
  const data = await api('/api/projects');
  app.cloudSettings = data.settings || app.cloudSettings;
  app.projectSlots = Number(data.projectSlots || 3);
  app.cloudProjects = Array.isArray(data.slots) ? data.slots : [];
  app.currentState = data.current || null;
  app.cloudRecovery = data.recovery || null;
  if (Number(app.projectSlot) < 1 || Number(app.projectSlot) > app.projectSlots) app.projectSlot = 1;
  renderStudentCloudStatus();
}

async function saveCurrentState() {
  if (app.state?.running && !app.state?.paused) return toast('请先暂停仿真，再保存当前状态');
  const wasRunning = !!app.state?.running;
  const data = await api('/api/current/save', { method: 'POST', body: '{}' });
  app.currentState = data.current || null;
  app.cloudProjects = data.slots || app.cloudProjects;
  renderStudentCloudStatus();
  toast(wasRunning ? '当前状态已保存' : '当前配置已保存（未启动）');
}

async function restoreCurrentState() {
  if (!app.currentState) {
    if (app.cloudRecovery) return restoreRecoveryCloud();
    return toast('还没有保存状态，也没有可恢复的自动保存');
  }
  if (!confirm('恢复上传保存状态会替换正在显示的仿真状态，是否继续？')) return;
  const data = await api('/api/current/restore', { method: 'POST', body: '{}' });
  applyCloudSimulationResult(data);
  await refreshStudentCloudStatus();
  toast('已恢复上传保存状态（未启动）');
}

async function uploadStudentCloud() {
  if (!simulationPaused()) return toast('请先暂停仿真，再上传云端');
  const slot = Number(app.projectSlot) || 2;
  // 云端1=导出云端，受教师开关；2/3/4 学生自由上传
  if (app.me?.role !== 'teacher' && slot === 1 && !app.cloudSettings.allowStudentUpload) {
    return toast('导出云端（云端1）未开放上传，请联系老师');
  }
  const assets = cloudUploadAssets();
  const data = await api(`/api/projects/${slot}/save`, { method: 'POST', body: JSON.stringify({ assets }) });
  app.cloudProjects = data.slots || app.cloudProjects;
  renderStudentCloudStatus();
  toast(slot === 1 ? '已上传到导出云端' : `已上传到云端 ${slot}`);
}

async function restoreStudentCloud() {
  const project = selectedProjectMeta();
  if (!project || project.empty) return toast('当前云端方案还没有保存内容');
  if (!confirm(`从云端方案 ${app.projectSlot} 下载会替换当前仿真状态，是否继续？`)) return;
  const data = await api(`/api/projects/${app.projectSlot}/restore`, { method: 'POST', body: '{}' });
  app.history = data.history || {};
  app.cloudProjects = data.slots || app.cloudProjects;
  clearParameterDirty();
  updateState(data.state);
  renderStudentCloudStatus();
  toast(`已从云端方案 ${app.projectSlot} 下载（未启动）`);
}

async function exportCurrentProject() {
  if (app.state?.running && !app.state?.paused) return toast('请先暂停仿真，再导出工程');
  const data = await api('/api/current/save', { method: 'POST', body: '{}' });
  app.currentState = data.current || null;
  app.cloudProjects = data.slots || app.cloudProjects;
  renderStudentCloudStatus();
  window.location.href = '/api/current/export';
}

async function importProjectFile(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return toast('工程文件不能超过 8 MB');
  let project;
  try { project = JSON.parse(await file.text()); } catch { return toast('工程文件不是有效的 JSON'); }
  if (!confirm('导入会覆盖当前状态并立即恢复该工程，是否继续？')) return;
  const data = await api('/api/current/import', { method: 'POST', body: JSON.stringify({ project }) });
  app.history = data.history || {};
  app.currentState = data.current || null;
  app.cloudProjects = data.slots || app.cloudProjects;
  clearParameterDirty();
  updateState(data.state);
  $('projectImportInput').value = '';
  renderStudentCloudStatus();
  toast('工程已导入当前状态');
}

async function restoreRecoveryCloud() {
  if (!app.cloudRecovery) return toast('没有可恢复的自动保存');
  if (!confirm('恢复自动保存会替换当前仿真状态，是否继续？')) return;
  const data = await api('/api/recovery/restore', { method: 'POST', body: '{}' });
  applyCloudSimulationResult(data);
  await refreshStudentCloudStatus();
  toast('已恢复自动保存（未启动）');
}

function cloudReasonText(reason) {
  return ({
    manual: '手动保存',
    logout: '退出登录自动保存',
    'forced-exit': '强制退出自动保存',
    'forced-exit-before-login': '重新进入前自动保存',
    'account-change': '账号变更前自动保存',
    'class-change': '班级变更前自动保存',
  })[reason] || reason || '云端保存';
}

function selectedCloudClass() {
  return (app.roster.classes || []).find((item) => item.id === app.teacherCloudClassFilter) || null;
}

function renderTeacherCloudFilters() {
  const classSelect = $('cloudClassFilter');
  const studentSelect = $('cloudStudentFilter');
  if (!classSelect || !studentSelect) return;
  const classes = app.roster.classes || [];
  if (!classes.some((item) => item.id === app.teacherCloudClassFilter)) app.teacherCloudClassFilter = '';
  classSelect.innerHTML = ['<option value="">请选择班级</option>', ...classes.map((item) => `<option value="${escapeAttr(item.id)}">${escapeHtml(item.name)}</option>`)].join('');
  classSelect.value = app.teacherCloudClassFilter;
  const selectedClass = selectedCloudClass();
  const students = selectedClass?.students || [];
  if (!students.some((item) => item.studentId === app.teacherCloudStudentFilter)) app.teacherCloudStudentFilter = '';
  const placeholder = selectedClass ? '请选择学生' : '请先选择班级';
  studentSelect.innerHTML = [`<option value="">${placeholder}</option>`, ...students.map((item) => `<option value="${escapeAttr(item.studentId)}">${escapeHtml(item.name)} (${escapeHtml(item.studentId)})</option>`)].join('');
  studentSelect.disabled = !selectedClass;
  studentSelect.value = app.teacherCloudStudentFilter;
  renderTeacherCloudSelection();
}

function teacherCloudProjectForStudent(studentId) {
  const modelFilter = String(app.teacherModelFilter || 'all');
  return (app.teacherCloudSubmissions || []).find((item) => item.classId === app.teacherCloudClassFilter
    && item.studentId === studentId
    && (modelFilter === 'all' || (item.modelId || 'tank') === modelFilter)
    && Number(item.slot || 1) === 1) || null;
}

function renderTeacherCloudSelection() {
  const container = $('cloudStudentChecklist');
  if (!container) return;
  const selectedClass = selectedCloudClass();
  const students = selectedClass?.students || [];
  if (!selectedClass) {
    app.teacherCloudSelectedStudents.clear();
    container.innerHTML = '<span class="muted small">请先选择班级</span>';
    const button = $('exportCloudZipBtn');
    if (button) button.disabled = true;
    const hint = $('cloudSelectionHint');
    if (hint) hint.textContent = '请选择班级和学生';
    return;
  }
  const validIds = new Set(students.map((student) => student.studentId));
  for (const studentId of Array.from(app.teacherCloudSelectedStudents)) {
    if (!validIds.has(studentId)) app.teacherCloudSelectedStudents.delete(studentId);
  }
  const uploadedCount = students.filter((student) => teacherCloudProjectForStudent(student.studentId)).length;
  container.innerHTML = students.map((student) => {
    const project = teacherCloudProjectForStudent(student.studentId);
    const checked = app.teacherCloudSelectedStudents.has(student.studentId);
    const status = project ? `已上传 ${cloudTime(project.savedAt || project.uploadedAt)}` : '未上传云端方案 1';
    return `<label class="cloud-student-check ${project ? 'uploaded' : ''}"><input type="checkbox" data-cloud-select-student="${escapeAttr(student.studentId)}" ${checked ? 'checked' : ''}><span>${escapeHtml(student.name)} (${escapeHtml(student.studentId)})<small>${escapeHtml(status)}</small></span></label>`;
  }).join('') || '<span class="muted small">该班暂无学生</span>';
  document.querySelectorAll('[data-cloud-select-student]').forEach((input) => {
    input.onchange = () => {
      if (input.checked) app.teacherCloudSelectedStudents.add(input.dataset.cloudSelectStudent);
      else app.teacherCloudSelectedStudents.delete(input.dataset.cloudSelectStudent);
      renderTeacherCloudSelection();
    };
  });
  const button = $('exportCloudZipBtn');
  if (button) button.disabled = app.cloudExportBusy || app.teacherCloudSelectedStudents.size === 0;
  const hint = $('cloudSelectionHint');
  if (hint) hint.textContent = `已选 ${app.teacherCloudSelectedStudents.size}/${students.length} 人；本班已上传 ${uploadedCount} 人`;
}

function renderTeacherCloudSubmissions() {
  const classId = app.teacherCloudClassFilter;
  const studentId = app.teacherCloudStudentFilter;
  const visible = classId && studentId
    ? (app.teacherCloudSubmissions || []).filter((item) => item.classId === classId && item.studentId === studentId)
    : [];
  const rows = visible.map((item) => {
    const spec = specOf(item.modelId);
    const modelId = item.modelId || 'tank';
    const measure = (spec.teacherSummary || []).map((tag) => number(item.tags?.[tag.key] ?? item[tag.key], tag.digits ?? 1) + (tag.unit || '')).join(' / ');
    return `
    <tr>
      <td>${cloudTime(item.savedAt || item.uploadedAt)}</td>
      <td>云端方案 ${number(item.slot || 1, 0)}</td>
      <td><span class="model-chip model-${escapeAttr(modelId)}">${escapeHtml(modelDisplayNameOf(modelId))}</span></td>
      <td>${escapeHtml(item.studentId)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.className)}</td>
      <td>${number(item.simTime, 1)} s</td>
      <td class="teacher-measure-cell">${escapeHtml(measure)}</td>
      <td>${escapeHtml(cloudReasonText(item.reason))}</td>
      <td><button data-cloud-load="${escapeAttr(item.classId)}" data-cloud-student="${escapeAttr(item.studentId)}" data-cloud-model="${escapeAttr(modelId)}" data-cloud-slot="${escapeAttr(item.slot || 1)}">读取到教师仿真</button> <button class="hidden" data-cloud-export="${escapeAttr(item.classId)}" data-cloud-export-student="${escapeAttr(item.studentId)}" data-cloud-export-slot="${escapeAttr(item.slot || 1)}" data-cloud-export-model="${escapeAttr(modelId)}">导出</button></td>
    </tr>`;
  });
  const emptyText = classId ? (studentId ? '该学生暂无云端工程' : '请选择学生') : '请选择班级';
  $('cloudSubmissionRows').innerHTML = rows.join('') || `<tr><td colspan="10" class="muted">${emptyText}</td></tr>`;
  document.querySelectorAll('[data-cloud-load]').forEach((btn) => {
    btn.onclick = () => loadStudentCloudIntoTeacher(btn.dataset.cloudLoad, btn.dataset.cloudStudent, btn.dataset.cloudSlot, btn.dataset.cloudModel);
  });
  document.querySelectorAll('[data-cloud-export]').forEach((btn) => {
    btn.onclick = () => {
      window.location.href = `/api/teacher/projects/${encodeURIComponent(btn.dataset.cloudExport)}/${encodeURIComponent(btn.dataset.cloudExportStudent)}/${encodeURIComponent(btn.dataset.cloudExportSlot)}/export?model=${encodeURIComponent(btn.dataset.cloudExportModel || 'tank')}`;
    };
  });
  const restore = $('restoreTeacherBackupBtn');
  const hint = $('teacherBackupHint');
  if (restore) restore.classList.toggle('hidden', !app.teacherBackup);
  if (hint) hint.textContent = app.teacherBackup
    ? `教师备份（${modelDisplayNameOf(app.teacherBackup.modelId)}）：${cloudTime(app.teacherBackup.backedUpAt)}`
    : '暂无教师备份';
}

function downloadNameFromHeader(header, fallback) {
  const match = String(header || '').match(/filename\*=UTF-8''([^;]+)/i);
  if (!match) return fallback;
  try { return decodeURIComponent(match[1]); } catch { return fallback; }
}

async function exportTeacherCloudZip() {
  const classId = app.teacherCloudClassFilter;
  const selectedClass = selectedCloudClass();
  const studentIds = Array.from(app.teacherCloudSelectedStudents);
  if (!classId || !selectedClass) return toast('请先选择班级');
  if (!studentIds.length) return toast('请至少选择一名学生');
  app.cloudExportBusy = true;
  renderTeacherCloudSelection();
  try {
    const response = await fetch('/api/teacher/cloud-export', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classId, studentIds, model: app.teacherModelFilter || 'all' }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const fallback = `${safeFilePart(selectedClass.name)}_${teacherModelLabel()}_云端导出_${localFileStamp()}.zip`;
    downloadBlob(blob, downloadNameFromHeader(response.headers.get('Content-Disposition'), fallback));
    toast(`已导出 ${studentIds.length} 名学生的云端数据`);
  } finally {
    app.cloudExportBusy = false;
    renderTeacherCloudSelection();
  }
}

async function loadTeacherCloudData() {
  const data = await api(`/api/teacher/submissions?${teacherQueryParams()}`);
  app.cloudSettings = data.settings || app.cloudSettings;
  app.teacherCloudSubmissions = data.submissions || [];
  app.teacherBackup = data.backup || null;
  const toggle = $('toggleStudentUploadBtn');
  if (toggle) {
    const allowed = !!app.cloudSettings.allowStudentUpload;
    toggle.textContent = `学生上传：${allowed ? '开放' : '关闭'}`;
    toggle.classList.toggle('on', allowed);
  }
  const hxToggle = $('toggleHxModelBtn');
  if (hxToggle) {
    const open = !!app.cloudSettings.openModels?.hx;
    hxToggle.textContent = `换热器模型：${open ? '开放' : '关闭'}`;
    hxToggle.classList.toggle('on', open);
  }
  renderTeacherCloudFilters();
  renderTeacherCloudSubmissions();
  renderTeacherCloudSelection();
}

function applyCloudSimulationResult(data) {
  app.history = data.history || {};
  clearParameterDirty();
  if (data.state) updateState(data.state);
}

// 教师登录时只绑定一个模型；读取别的模型的学生方案时要先把教师仿真切过去。
async function switchTeacherActiveModel(modelId) {
  const model = MODEL_SPECS[modelId] ? modelId : 'tank';
  if ((app.me?.model || 'tank') === model) return;
  const data = await api('/api/teacher/active-model', { method: 'POST', body: JSON.stringify({ model }) });
  app.me = { ...(app.me || {}), model: data.model || model };
  applyModelSpec(data.model || model);
  renderSpecShell();
  if (app.simEventSource) app.simEventSource.close();
  app.simEventSource = new EventSource('/api/stream');
  app.simEventSource.addEventListener('open', () => setConnection(true, '教师仿真已连接'));
  app.simEventSource.addEventListener('state', (e) => {
    const state = JSON.parse(e.data);
    appendHistory(state);
    updateState(state);
  });
  app.simEventSource.addEventListener('error', () => setConnection(false, '仿真重连中'));
  app.history = data.history || {};
  if (data.state) updateState(data.state);
  toast(`教师仿真已切换到「${modelDisplayNameOf(model)}」`);
}

async function loadStudentCloudIntoTeacher(classId, studentId, slot = 1, modelId = 'tank') {
  const model = MODEL_SPECS[modelId] ? modelId : 'tank';
  if (!confirm(`读取该学生（${modelDisplayNameOf(model)}）的云端方案 ${slot} 会替换教师当前仿真。系统会先自动备份教师当前状态，是否继续？`)) return;
  const data = await api('/api/teacher/load-project', { method: 'POST', body: JSON.stringify({ classId, studentId, slot: Number(slot), model }) });
  app.teacherBackup = data.backup || app.teacherBackup;
  if ((app.me?.model || 'tank') !== model) {
    await switchTeacherActiveModel(model);
  } else {
    applyCloudSimulationResult(data);
  }
  renderTeacherCloudSubmissions();
  switchView('control');
  toast(`已读取 ${studentId} 的云端状态（${modelDisplayNameOf(model)}）`);
}

async function restoreTeacherCloudBackup() {
  if (!app.teacherBackup) return toast('没有可恢复的教师备份');
  if (!confirm('恢复教师载入前的状态并替换当前仿真，是否继续？')) return;
  const model = app.teacherBackup.modelId || (app.me?.model || 'tank');
  const data = await api('/api/teacher/restore-backup', { method: 'POST', body: JSON.stringify({ model }) });
  if ((app.me?.model || 'tank') !== model) {
    await switchTeacherActiveModel(model);
  } else {
    applyCloudSimulationResult(data);
  }
  switchView('control');
  toast('教师载入前状态已恢复');
}

async function loadModelOptions() {
  const data = await api('/api/model/list');
  const studentModel = $('studentModel');
  if (studentModel) {
    const hxOpen = (data.models || []).some((item) => item.id === 'hx' && item.open);
    const hxOption = studentModel.querySelector('option[value="hx"]');
    if (hxOption) {
      hxOption.disabled = !hxOpen;
      hxOption.classList.toggle('hidden', !hxOpen);
    }
    if (!hxOpen && studentModel.value === 'hx') studentModel.value = 'tank';
  }
  return data;
}

async function connectStudent() {
  const me = await api('/api/me');
  app.me = me;
  applyModelSpec(me.model || 'tank');
  renderSpecShell();
  showApp();
  const snapshot = await api('/api/state');
  app.history = snapshot.history || {};
  updateState(snapshot.state || snapshot);
  await refreshStudentCloudStatus();
  app.simEventSource = new EventSource('/api/stream');
  app.simEventSource.addEventListener('open', () => setConnection(true, '已连接'));
  app.simEventSource.addEventListener('settings', (e) => {
    app.cloudSettings = JSON.parse(e.data);
    renderStudentCloudStatus();
  });
  app.simEventSource.addEventListener('state', (e) => {
    const state = JSON.parse(e.data);
    appendHistory(state);
    updateState(state);
  });
  app.simEventSource.addEventListener('error', () => setConnection(false, '重连中'));
  setConnection(true, '已连接');
}

async function connectTeacher() {
  const me = await api('/api/me');
  app.me = me;
  applyModelSpec(me.model || 'tank');
  renderSpecShell();
  showApp();
  await loadRoster();
  await loadTeacher();
  const snapshot = await api('/api/state');
  app.history = snapshot.history || {};
  updateState(snapshot.state || snapshot);

  app.simEventSource = new EventSource('/api/stream');
  await refreshStudentCloudStatus();
  app.simEventSource.addEventListener('open', () => setConnection(true, '教师仿真已连接'));
  app.simEventSource.addEventListener('state', (e) => {
    const state = JSON.parse(e.data);
    appendHistory(state);
    updateState(state);
  });
  app.simEventSource.addEventListener('error', () => setConnection(false, '仿真重连中'));

  openTeacherStream();
}

// 教师看板 SSE：模型筛选变化时要重新订阅，否则看板会被钉在旧模型上。
function openTeacherStream() {
  if (app.teacherEventSource) app.teacherEventSource.close();
  const model = encodeURIComponent(String(app.teacherModelFilter || 'all'));
  app.teacherEventSource = new EventSource(`/api/teacher/stream?model=${model}`);
  app.teacherEventSource.addEventListener('open', () => setConnection(true, `教师看板已连接（${teacherModelLabel()}）`));
  app.teacherEventSource.addEventListener('overview', (e) => {
    const data = JSON.parse(e.data);
    app.teacherOverview = data.sessions || [];
    renderTeacherRows();
  });
  app.teacherEventSource.addEventListener('error', () => setConnection(false, '教师看板重连中'));
}

async function loadTeacher() {
  if (app.roster.classes.length === 0) await loadRoster();
  renderTeacherDefinition();
  const data = await api(`/api/teacher/overview?${teacherQueryParams()}`);
  app.teacherOverview = data.sessions || [];
  renderTeacherRows();
  if (!app.selectedStudent) {
    app.teacherCurve.history = { t: [] };
    renderTeacherLegend();
    const defs = teacherCurveDefs();
    const def = defs.level || defs[Object.keys(defs)[0]];
    drawChart($('teacherChart'), [], def?.yLabel || '', { curve: app.teacherCurve, group: 'level', unit: def?.unit || '', fixedYMax: def?.fixedYMax, yMin: 0, yMax: def?.fixedYMax, emptyText: '点击「查看曲线」查看学生实时曲线' });
  }
  await loadTeacherCloudData();
  await loadRecords();
}

function renderTeacherClassFilter() {
  const select = $('teacherClassFilter');
  if (!select) return;
  const options = ['<option value="">全部班级</option>'];
  for (const item of app.roster.classes) {
    options.push(`<option value="${escapeAttr(item.id)}">${escapeHtml(item.name)}</option>`);
  }
  select.innerHTML = options.join('');
  if (!app.roster.classes.some((item) => item.id === app.teacherClassFilter)) app.teacherClassFilter = '';
  select.value = app.teacherClassFilter;
}

function teacherParamKey(session) {
  return `${session.modelId || 'tank'}::${session.classId}::${session.studentId}`;
}


function teacherLoopRows(session) {
  const modelId = session.modelId || 'tank';
  const loops = Array.isArray(session.loopParams) ? session.loopParams : [];
  if (!loops.length) return '<div class="muted small">未搭建单回路</div>';
  return loops.map((loop, index) => `
    <div class="teacher-param-line">
      <strong>单回路 ${index + 1}：${mvNameOf(modelId, loop.mv)} → ${pvNameOf(modelId, loop.pv)}</strong>
      <span>${loop.manual ? '手动' : '自动'} / ${loop.action > 0 ? '正作用' : '反作用'}</span>
      <span>SP ${number(loop.sp, 1)}% · PV ${number(loop.pvValue, 1)}% · 输出 ${number(loop.out, 1)}%</span>
      <span>Kp ${number(loop.kp, 3)} · Ti ${tiText(loop.ti)} · Td ${number(loop.td, 1)} · 手操 ${number(loop.manualOut, 1)}%</span>
    </div>`).join('');
}

function teacherCascadeRows(session) {
  const modelId = session.modelId || 'tank';
  const cascades = Array.isArray(session.cascadeParams) ? session.cascadeParams : [];
  if (!cascades.length) return '<div class="muted small">未搭建串级</div>';
  return cascades.map((cascade, index) => `
    <div class="teacher-param-line">
      <strong>串级 ${index + 1}：${mvNameOf(modelId, cascade.mv)} → ${pvNameOf(modelId, cascade.inner)} → ${pvNameOf(modelId, cascade.outer)}</strong>
      <span>主环 ${cascade.outerManual ? '手动' : '自动'} / ${cascade.outerAction > 0 ? '正作用' : '反作用'} · 副环 ${cascade.innerManual ? '手动' : '自动'} / ${cascade.innerAction > 0 ? '正作用' : '反作用'}</span>
      <span>主环 SP ${number(cascade.outerSp, 1)} · PV ${number(cascade.outerPvValue, 1)} · 输出 ${number(cascade.outerOut, 1)}%</span>
      <span>主环 Kp ${number(cascade.outerKp, 3)} · Ti ${tiText(cascade.outerTi)} · Td ${number(cascade.outerTd, 1)}</span>
      <span>副环 PV ${number(cascade.innerPvValue, 1)} · 输出 ${number(cascade.innerOut, 1)}% · Kp ${number(cascade.innerKp, 3)} · Ti ${tiText(cascade.innerTi)} · Td ${number(cascade.innerTd, 1)}</span>
    </div>`).join('');
}

function teacherParamDetails(session) {
  const spec = specOf(session.modelId || 'tank');
  const tags = session.tags || session;
  const actuators = (spec.actuatorReadouts || []).map((item) => '<div class="teacher-param-line"><strong>' + escapeHtml(item.label) + '</strong><span>实际 ' + number(tags[item.key], 1) + '% · 指令 ' + number(item.cmdKey ? tags[item.cmdKey] : tags[item.key], 1) + '%</span></div>').join('');
  const setpoints = (spec.setpointReadouts || []).map((item) => '<div class="teacher-param-line"><strong>' + escapeHtml(item.label) + '</strong><span>SP ' + number(tags[item.key], 1) + (item.unit || '') + '</span></div>').join('');
  return '<div class="teacher-param-grid">' +
    '<div class="teacher-param-block"><h3>实验模型</h3><div class="teacher-param-line"><strong>' + escapeHtml(spec.displayName) + '</strong><span>学号 ' + escapeHtml(String(session.studentId || '')) + '</span></div></div>' +
    '<div class="teacher-param-block"><h3>执行器</h3>' + actuators + '</div>' +
    '<div class="teacher-param-block"><h3>给定值</h3>' + setpoints + '<div class="teacher-param-line"><strong>前馈偏置</strong><span>' + (session.bias ? '开' : '关') + '</span></div></div>' +
    '<div class="teacher-param-block teacher-param-block-wide"><h3>回路参数</h3>' + teacherLoopRows(session) + '</div>' +
    '<div class="teacher-param-block teacher-param-block-wide"><h3>串级参数</h3>' + teacherCascadeRows(session) + '</div>' +
  '</div>';
}
function renderTeacherRows() {
  const sessions = filteredTeacherOverview();
  const single = String(app.teacherModelFilter || 'all') !== 'all';
  const summary = single ? (modelSpec().teacherSummary || []) : [];
  const middleCols = single ? summary.length : 1;
  const colspan = 5 + middleCols + 3;
  const rows = sessions.map((s) => {
    const key = teacherParamKey(s);
    const modelId = s.modelId || 'tank';
    const expanded = app.expandedTeacherParams.has(key);
    const tags = s.tags || s;
    const summaryCells = single
      ? summary.map((item) => '<td>' + number(tags[item.key], item.digits ?? 1) + (item.unit || '') + '</td>').join('')
      : '<td class="teacher-measure-cell">' + escapeHtml((specOf(modelId).teacherSummary || []).map((item) => item.label + ' ' + number(tags[item.key], item.digits ?? 1) + (item.unit || '')).join(' · ')) + '</td>';
    return `
    <tr>
      <td>${escapeHtml(s.studentId)}</td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.className)}</td>
      <td><span class="model-chip model-${escapeAttr(modelId)}">${escapeHtml(modelDisplayNameOf(modelId))}</span></td>
      <td><span class="mini">${s.running ? (s.paused ? '暂停' : '运行') : '未启动'}</span></td>
      ${summaryCells}
      <td>${s.loops}/${s.cascades}</td><td>${number(s.scoreTotal, 1)}</td>
      <td class="teacher-actions-cell"><div class="button-row teacher-row-actions"><button data-teacher-param-model="${escapeAttr(modelId)}" data-teacher-param-class="${escapeAttr(s.classId)}" data-teacher-param-student="${escapeAttr(s.studentId)}">${expanded ? '收起参数' : '参数详情'}</button><button data-teacher-class="${escapeAttr(s.classId)}" data-teacher-student="${escapeAttr(s.studentId)}" data-teacher-student-model="${escapeAttr(modelId)}">查看曲线</button></div></td>
    </tr>
    <tr class="teacher-param-row ${expanded ? '' : 'hidden'}" data-teacher-param-row="${escapeAttr(key)}"><td colspan="${colspan}">${teacherParamDetails(s)}</td></tr>`;
  });
  $('teacherRows').innerHTML = rows.join('') || '<tr><td colspan="' + colspan + '" class="muted">暂无在线学生</td></tr>';
  document.querySelectorAll('[data-teacher-param-class]').forEach((btn) => {
    btn.onclick = () => {
      const key = `${btn.dataset.teacherParamModel || 'tank'}::${btn.dataset.teacherParamClass}::${btn.dataset.teacherParamStudent}`;
      const row = Array.from(document.querySelectorAll('[data-teacher-param-row]')).find((item) => item.dataset.teacherParamRow === key);
      if (app.expandedTeacherParams.has(key)) app.expandedTeacherParams.delete(key);
      else app.expandedTeacherParams.add(key);
      const expanded = app.expandedTeacherParams.has(key);
      if (row) row.classList.toggle('hidden', !expanded);
      btn.textContent = expanded ? '收起参数' : '参数详情';
    };
  });
  document.querySelectorAll('[data-teacher-student]').forEach((btn) => {
    btn.onclick = () => showTeacherStudent(btn.dataset.teacherClass, btn.dataset.teacherStudent, btn.dataset.teacherStudentModel || 'tank');
  });
}
// 教师曲线按「正在查看的学生模型」取定义与历史通道，不受教师自身模型影响。
function teacherCurveDefs() {
  return specOf(app.teacherCurve.modelId).curveGroups || CURVE_DEFS;
}
function teacherHistoryKeys() {
  return specOf(app.teacherCurve.modelId).historyKeys || ['t'];
}
function teacherStreamTemplate() {
  const streams = {};
  for (const [group, definition] of Object.entries(teacherCurveDefs())) {
    streams[group] = new Set(definition.series.map((item) => item.key));
  }
  return streams;
}

function normalizeCourseHistory(history) {
  const source = history && typeof history === 'object' ? history : {};
  const output = {};
  for (const key of teacherHistoryKeys()) {
    output[key] = Array.isArray(source[key]) ? source[key].slice(-1800) : [];
  }
  return output;
}

function resetTeacherHistoryClock(history, state) {
  const lastDisplay = Number(history?.t?.[history.t.length - 1]);
  const raw = Number(state?.sim_time);
  app.teacherHistoryClock = {
    offset: Number.isFinite(lastDisplay) && Number.isFinite(raw) && lastDisplay >= raw ? lastDisplay - raw : 0,
    lastRawT: Number.isFinite(raw) ? raw : null,
    lastDisplayT: Number.isFinite(lastDisplay) ? lastDisplay : (Number.isFinite(raw) ? raw : null),
  };
}

function appendTeacherHistory(state) {
  if (!state) return;
  const curve = app.teacherCurve;
  if (!Array.isArray(curve.history.t)) curve.history = normalizeCourseHistory(curve.history);
  const rawT = Number(state.sim_time || 0);
  const clock = app.teacherHistoryClock;
  if (!Number.isFinite(clock.lastRawT)) {
    if (Number.isFinite(clock.lastDisplayT) && rawT < clock.lastDisplayT) clock.offset = clock.lastDisplayT - rawT;
  } else if (rawT + 1e-9 < clock.lastRawT) {
    clock.offset = Math.max(clock.offset, (Number(clock.lastDisplayT) || rawT) + 0.1 - rawT);
  }
  const t = rawT + clock.offset;
  clock.lastRawT = rawT;
  clock.lastDisplayT = t;
  const fields = teacherHistoryKeys().filter((key) => key !== 't');
  const previous = curve.history.t[curve.history.t.length - 1];
  const replace = t === previous && curve.history.t.length > 0;
  if (replace) curve.history.t[curve.history.t.length - 1] = t; else curve.history.t.push(t);
  for (const key of fields) {
    if (!Array.isArray(curve.history[key])) curve.history[key] = [];
    const value = Number(state[key] || 0);
    if (replace) curve.history[key][curve.history[key].length - 1] = value; else curve.history[key].push(value);
  }
  if (curve.history.t.length > 1800) {
    Object.keys(curve.history).forEach((key) => curve.history[key].splice(0, curve.history[key].length - 1800));
  }
}

function teacherCurveSeries() {
  const group = app.teacherCurve.active;
  const defs = teacherCurveDefs();
  const definition = defs[group] || defs.level;
  return definition.series.filter((item) => app.teacherCurve.streams[group].has(item.key));
}

function renderTeacherLegend() {
  const group = app.teacherCurve.active;
  const defs = teacherCurveDefs();
  const definition = defs[group] || defs.level;
  const buttons = definition.series.map((item) => `<button data-teacher-series="${escapeAttr(item.key)}" class="${app.teacherCurve.streams[group].has(item.key) ? 'active' : ''}">${escapeHtml(item.label)}</button>`);
  if (group === 'flow') {
    const limit = Number(specOf(app.teacherCurve.modelId).flowYLimit) || 100;
    buttons.push('<label class="y-max">Y 上限<input id="teacherFlowYMax" type="number" min="1" max="' + limit + '" step="' + (limit <= 20 ? '0.5' : '1') + '" placeholder="自动"></label>');
  }
  $('teacherCurveLegend').innerHTML = buttons.join('');
  document.querySelectorAll('[data-teacher-series]').forEach((button) => {
    button.onclick = () => {
      const key = button.dataset.teacherSeries;
      const set = app.teacherCurve.streams[group];
      if (set.has(key)) set.delete(key); else set.add(key);
      renderTeacherLegend();
      drawTeacherChart();
    };
  });
  const flowMax = $('teacherFlowYMax');
  if (flowMax) {
    flowMax.value = Number.isFinite(Number(app.teacherCurve.flowYMax)) ? String(app.teacherCurve.flowYMax) : '';
    flowMax.oninput = () => {
      app.teacherCurve.flowYMax = normalizedFlowYMax(flowMax.value, app.teacherCurve.modelId);
      drawTeacherChart();
    };
    flowMax.onchange = () => {
      app.teacherCurve.flowYMax = normalizedFlowYMax(flowMax.value, app.teacherCurve.modelId);
      flowMax.value = app.teacherCurve.flowYMax === null ? '' : String(app.teacherCurve.flowYMax);
      drawTeacherChart();
    };
  }
}

function switchTeacherCurveTab(group) {
  const next = teacherCurveDefs()[group] ? group : 'level';
  app.teacherCurve.active = next;
  document.querySelectorAll('[data-teacher-curve-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.teacherCurveTab === next);
  });
  renderTeacherLegend();
  drawTeacherChart();
}

function drawTeacherChart() {
  if (!app.selectedStudent) return;
  const group = app.teacherCurve.active;
  const defs = teacherCurveDefs();
  const definition = defs[group] || defs.level;
  const options = { group, unit: definition.unit, fixedYMax: definition.fixedYMax, curve: app.teacherCurve };
  if (group !== 'flow') options.maxY = definition.fixedYMax;
  if (group === 'flow') {
    const flowLimit = normalizedFlowYMax(app.teacherCurve.flowYMax, app.teacherCurve.modelId);
    if (flowLimit !== null) options.maxY = flowLimit;
  }
  drawChart($('teacherChart'), teacherCurveSeries(), definition.yLabel, options);
}

function closeTeacherStudentStream() {
  if (app.teacherStudentStream) app.teacherStudentStream.close();
  app.teacherStudentStream = null;
  app.teacherStudentKey = null;
}

// 教师看板跨模型查看：曲线定义、显隐集合与坐标范围都跟着被查看学生的模型走。
function applyTeacherCurveModel(modelId) {
  const id = MODEL_SPECS[modelId] ? modelId : 'tank';
  const changed = app.teacherCurve.modelId !== id;
  app.teacherCurve.modelId = id;
  if (changed) {
    app.teacherCurve.streams = teacherStreamTemplate();
    app.teacherCurve.ranges = defaultRangesOf(id);
    app.teacherCurve.flowYMax = null;
    app.teacherCurve.active = 'level';
  }
  if (!teacherCurveDefs()[app.teacherCurve.active]) app.teacherCurve.active = 'level';
}

function connectTeacherStudentStream(classId, studentId, modelId) {
  closeTeacherStudentStream();
  const model = modelId || 'tank';
  const key = `${model}::${classId}::${studentId}`;
  app.teacherStudentKey = key;
  const source = new EventSource(`/api/teacher/watch?classId=${encodeURIComponent(classId)}&studentId=${encodeURIComponent(studentId)}&model=${encodeURIComponent(model)}`);
  app.teacherStudentStream = source;
  source.addEventListener('snapshot', (event) => {
    if (app.teacherStudentKey !== key) return;
    const data = JSON.parse(event.data);
    app.selectedStudent = data;
    app.teacherCurve.history = normalizeCourseHistory(data.history);
    resetTeacherHistoryClock(app.teacherCurve.history, data.state || {});
    drawTeacherChart();
  });
  source.addEventListener('state', (event) => {
    if (app.teacherStudentKey !== key) return;
    const state = JSON.parse(event.data);
    appendTeacherHistory(state);
    drawTeacherChart();
  });
  source.addEventListener('error', () => {
    if (app.teacherStudentKey === key) drawTeacherChart();
  });
}

async function showTeacherStudent(classId, studentId, modelId) {
  const model = MODEL_SPECS[modelId] ? modelId : 'tank';
  try {
    closeTeacherStudentStream();
    const data = await api(`/api/teacher/student/${encodeURIComponent(classId)}/${encodeURIComponent(studentId)}?model=${encodeURIComponent(model)}`);
    applyTeacherCurveModel(model);
    app.selectedStudent = data;
    app.teacherCurve.history = normalizeCourseHistory(data.history);
    resetTeacherHistoryClock(app.teacherCurve.history, data.state || {});
    $('teacherDetailTitle').textContent = `学生实时曲线（${modelDisplayNameOf(model)}）：${data.className || ''} / ${data.name || studentId}`;
    renderTeacherLegend();
    drawTeacherChart();
    connectTeacherStudentStream(classId, studentId, model);
  } catch (err) {
    toast(err.message);
  }
}

async function loadRecords() {
  const data = await api(`/api/teacher/records?${teacherQueryParams()}`);
  const rows = (data.records || []).slice(-100).map((r) => {
    const labels = specOf(r.modelId).scoreLabels || {};
    const modeText = Number(r.mode) === 1 ? (labels.mode1 || '单回路评分') : (labels.mode2 || '系统评分');
    return `
    <tr><td>${new Date(r.endedAt).toLocaleString()}</td><td>${escapeHtml(modelDisplayNameOf(r.modelId))}</td><td>${escapeHtml(r.studentId)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.className)}</td>
    <td>${escapeHtml(modeText)}</td><td>${number(r.score.total, 1)}</td><td>${number(r.score.control, 1)}</td><td>${number(r.score.safety, 1)}</td><td>${number(r.score.benefit, 1)}</td></tr>`;
  });
  $('recordRows').innerHTML = rows.join('') || '<tr><td colspan="10" class="muted">暂无评分记录</td></tr>';
}

async function loadRoster() {
  const data = await api('/api/teacher/classes');
  app.roster.classes = data.classes || [];
  if (!app.roster.classes.some((item) => item.id === app.roster.selectedClassId)) {
    app.roster.selectedClassId = app.roster.classes[0]?.id || null;
  }
  renderRoster();
}

function renderRoster() {
  renderTeacherCloudFilters();
  renderTeacherClassFilter();
  const classes = app.roster.classes || [];
  const classRows = classes.map((item) => {
    const students = item.students || [];
    const enabledCount = students.filter((student) => student.enabled).length;
    return `
    <tr>
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.code)}</td>
      <td>${enabledCount}/${students.length}</td>
      <td>${item.enabled ? '启用' : '停用'}</td>
      <td><button data-class-select="${escapeAttr(item.id)}">${item.id === app.roster.selectedClassId ? '当前班级' : '选择'}</button></td>
    </tr>`;
  });
  $('classRows').innerHTML = classRows.join('') || '<tr><td colspan="5" class="muted">暂无班级</td></tr>';

  const selected = currentClass();
  const disabled = !selected;
  $('rosterClassName').disabled = disabled;
  $('rosterClassCode').disabled = disabled;
  $('rosterClassEnabled').disabled = disabled;
  $('saveClassBtn').disabled = disabled;
  $('addStudentBtn').disabled = disabled;
  $('exportRosterBtn').disabled = disabled;
  $('deleteClassBtn').disabled = disabled;
  $('importMergeBtn').disabled = disabled;
  $('importReplaceBtn').disabled = disabled;
  if (!selected) {
    $('rosterTitle').textContent = '学生名单';
    $('rosterClassName').value = '';
    $('rosterClassCode').value = '';
    $('rosterClassEnabled').checked = false;
    $('rosterStudentRows').innerHTML = '<tr><td colspan="4" class="muted">请先新建班级</td></tr>';
    return;
  }

  $('rosterTitle').textContent = `学生名单：${selected.name}`;
  $('rosterClassName').value = selected.name;
  $('rosterClassCode').value = selected.code;
  $('rosterClassEnabled').checked = selected.enabled;
  const studentRows = (selected.students || []).map((student) => `
    <tr>
      <td><input data-student-id="${escapeAttr(student.studentId)}" value="${escapeAttr(student.studentId)}"></td>
      <td><input data-student-name="${escapeAttr(student.studentId)}" value="${escapeAttr(student.name)}"></td>
      <td><label class="inline-label"><input data-student-enabled="${escapeAttr(student.studentId)}" type="checkbox" ${student.enabled ? 'checked' : ''}> 启用</label></td>
      <td><button data-student-save="${escapeAttr(student.studentId)}">保存</button> <button data-student-delete="${escapeAttr(student.studentId)}" class="danger">删除</button></td>
    </tr>`);
  $('rosterStudentRows').innerHTML = studentRows.join('') || '<tr><td colspan="4" class="muted">当前班级还没有学生</td></tr>';
}

const ROSTER_HEADER_ALIASES = {
  id: ['学号', '学生学号', '学生编号', '编号', '学籍号', 'id', 'studentid', 'student id', 'student_no'],
  name: ['姓名', '学生姓名', '名字', 'name', 'studentname', 'student name'],
};

function rosterCellText(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').replace(/\u00a0/g, ' ').trim();
}

function normalizeRosterHeader(value) {
  return rosterCellText(value).toLowerCase().replace(/[\s_-]+/g, '');
}

function isRosterHeader(value, kind) {
  const normalized = normalizeRosterHeader(value);
  return ROSTER_HEADER_ALIASES[kind].some((item) => normalizeRosterHeader(item) === normalized);
}

function findRosterColumns(matrix) {
  const limit = Math.min(matrix.length, 10);
  for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
    const row = Array.isArray(matrix[rowIndex]) ? matrix[rowIndex] : [];
    const idIndex = row.findIndex((cell) => isRosterHeader(cell, 'id'));
    const nameIndex = row.findIndex((cell) => isRosterHeader(cell, 'name'));
    if (idIndex >= 0 && nameIndex >= 0 && idIndex !== nameIndex) {
      return { idIndex, nameIndex, dataStart: rowIndex + 1 };
    }
  }
  return { idIndex: 0, nameIndex: 1, dataStart: 0 };
}

function normalizeRosterRows(rows, rowOffset = 1) {
  const cleaned = [];
  const seen = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const studentId = rosterCellText(rows[index].studentId);
    const name = rosterCellText(rows[index].name);
    if (!studentId && !name) continue;
    const rowNumber = index + rowOffset;
    if (!studentId) throw new Error(`第 ${rowNumber} 行缺少学号`);
    if (!name) throw new Error(`第 ${rowNumber} 行缺少姓名`);
    if (!/^[0-9A-Za-z_\-.\u4e00-\u9fff]{1,80}$/.test(studentId)) {
      throw new Error(`第 ${rowNumber} 行学号格式不正确：${studentId}`);
    }
    if (seen.has(studentId)) throw new Error(`第 ${rowNumber} 行学号重复：${studentId}`);
    seen.add(studentId);
    cleaned.push({ studentId, name });
  }
  if (!cleaned.length) throw new Error('没有可导入的名单');
  if (cleaned.length > 5000) throw new Error('单次最多导入 5000 名学生');
  return cleaned;
}

function parseRosterText() {
  const lines = $('rosterImportText').value.split(/\r?\n/);
  const rows = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.replaceAll('，', ',').split(',');
    if (parts.length < 2) throw new Error(`格式不正确：${line}`);
    rows.push({ studentId: parts[0].trim(), name: parts.slice(1).join(',').trim() });
  }
  return normalizeRosterRows(rows, 1);
}

async function parseRosterFile(file) {
  if (!window.XLSX) throw new Error('Excel 解析组件未加载，请刷新页面重试');
  const extension = String(file.name || '').toLowerCase().split('.').pop();
  if (!['xlsx', 'xls', 'csv'].includes(extension)) {
    throw new Error('仅支持 .xlsx、.xls、.csv 文件；宏文件请另存为 .xlsx');
  }
  if (file.size > 10 * 1024 * 1024) throw new Error('文件不能超过 10 MB');
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', codepage: 65001 });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('文件中没有工作表');
  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });
  const { idIndex, nameIndex, dataStart } = findRosterColumns(matrix);
  const rows = matrix.slice(dataStart).map((row) => ({
    studentId: rosterCellText(row[idIndex]),
    name: rosterCellText(row[nameIndex]),
  }));
  return { rows: normalizeRosterRows(rows, dataStart + 1), sheetName };
}

function renderRosterImportPreview(rows, sourceName) {
  app.rosterImportRows = rows;
  app.rosterImportFileName = sourceName;
  $('rosterFileName').textContent = `${sourceName} · 共 ${rows.length} 条`;
  $('rosterFileName').classList.remove('hidden');
  $('clearRosterFileBtn').classList.remove('hidden');
  $('rosterPreviewRows').innerHTML = rows.slice(0, 100).map((row) => `
    <tr><td>${escapeHtml(row.studentId)}</td><td>${escapeHtml(row.name)}</td></tr>`).join('');
  $('rosterPreviewSummary').textContent = rows.length > 100 ? `共 ${rows.length} 条，预览前 100 条` : `共 ${rows.length} 条`;
  $('rosterPreviewWrap').classList.remove('hidden');
}

function clearRosterImportFile(resetInput = true) {
  app.rosterImportRows = [];
  app.rosterImportFileName = '';
  if (resetInput) $('rosterFileInput').value = '';
  $('rosterFileName').classList.add('hidden');
  $('clearRosterFileBtn').classList.add('hidden');
  $('rosterPreviewWrap').classList.add('hidden');
}

function getRosterImportRows() {
  return app.rosterImportRows.length ? app.rosterImportRows : parseRosterText();
}

function applySimScale() {
  const viewport = document.querySelector('.process-viewport');
  const visual = [$('processVisual'), $('hxProcessVisual')].find(el => el && !el.classList.contains('hidden'));
  if (!viewport || !visual) return;
  if (app.simVisualId !== visual.id) {
    app.simInteraction?.cancel();
    app.simVisualId = visual.id;
  }
  const camera = getSimCamera();
  if (!camera.update({ width: visual.offsetWidth, height: visual.offsetHeight,
    viewportWidth: viewport.clientWidth, viewportHeight: viewport.clientHeight })) return;
  const frame = camera.frame();
  visual.style.transformOrigin = '0 0';
  visual.style.setProperty('--sim-label-scale', clamp(1 / frame.scale, 0.86, 1.2).toFixed(3));
  visual.style.transform = `translate(${frame.x}px, ${frame.y}px) scale(${frame.scale})`;
  const readout = $('simZoomValue');
  if (readout) readout.textContent = `${Math.round(frame.scale * 100)}%`;
  if ($('simZoomOutBtn')) $('simZoomOutBtn').disabled = frame.scale <= camera.fitScale() + 1e-9;
  if ($('simZoomInBtn')) $('simZoomInBtn').disabled = frame.scale >= 1.8 - 1e-9;
}

function getSimCamera() {
  return app.simViews.camera(modelSpec().renderer,
    document.querySelector('.sim-panel')?.classList.contains('expanded'));
}

function setSimScale(nextScale) {
  getSimCamera().setScale(nextScale);
  applySimScale();
}

function setSimExpanded(expanded) {
  const panel = document.querySelector('.sim-panel');
  const backdrop = $('simBackdrop');
  const button = $('simExpandBtn');
  if (!panel || !backdrop) return;
  panel.classList.toggle('expanded', expanded);
  backdrop.classList.toggle('hidden', !expanded);
  document.body.classList.toggle('sim-expanded', expanded);
  app.simInteraction?.cancel();
  if (button) {
    button.classList.toggle('on', expanded);
    button.title = expanded ? '退出全屏仿真图' : '放大到全屏区域';
    button.setAttribute('aria-pressed', String(expanded));
  }
  requestAnimationFrame(applySimScale);
}

function setPidPanelVisible(visible) {
  app.pidPanelVisible = !!visible;
  const panel = document.querySelector('.pid-panel');
  const grid = document.querySelector('.control-grid');
  if (panel) panel.classList.toggle('pid-panel-hidden', !app.pidPanelVisible);
  if (grid) grid.classList.toggle('pid-hidden', !app.pidPanelVisible);
  $('pidShowBtn')?.classList.toggle('hidden', app.pidPanelVisible);
}

function applySecondaryLabelVisibility() {
  // 「次要标签」按钮已移除：图上不再需要该开关
  return;
  const visible = app.showSecondaryLabels !== false;
  for (const visual of [$('processVisual'), $('hxProcessVisual')].filter(Boolean)) {
    visual.classList.toggle('secondary-labels-hidden', !visible);
  }
  const toggle = $('simLabelToggleBtn');
  if (toggle) {
    toggle.classList.toggle('on', visible);
    toggle.setAttribute('aria-pressed', String(visible));
    toggle.title = visible ? '隐藏次要标签' : '显示次要标签';
  }
}

function wirePidPanelControls() {
  const hide = $('pidToggleBtn');
  const show = $('pidShowBtn');
  if (hide) hide.onclick = () => setPidPanelVisible(false);
  if (show) show.onclick = () => setPidPanelVisible(true);
  setPidPanelVisible(app.pidPanelVisible);
}

function wireSimControls() {
  const zoomOut = $('simZoomOutBtn');
  const zoomIn = $('simZoomInBtn');
  const fit = $('simFitBtn');
  const expand = $('simExpandBtn');
  const backdrop = $('simBackdrop');
  const wireToggle = $('simWiresBtn');
  const viewport = document.querySelector('.process-viewport');
  if (zoomOut) zoomOut.onclick = () => setSimScale(getSimCamera().scale - 0.1);
  if (zoomIn) zoomIn.onclick = () => setSimScale(getSimCamera().scale + 0.1);
  if (fit) fit.onclick = () => { app.simInteraction?.cancel(); getSimCamera().fit(); applySimScale(); };
  if (expand) expand.onclick = () => setSimExpanded(!document.querySelector('.sim-panel')?.classList.contains('expanded'));
  if (wireToggle) wireToggle.onclick = () => {
    if (!wireToggle) return;
    app.showProcessWires = !app.showProcessWires;
    wireToggle.classList.toggle('on', app.showProcessWires);
    wireToggle.setAttribute('aria-pressed', String(app.showProcessWires));
    wireToggle.title = app.showProcessWires ? '隐藏控制接线' : '显示控制接线';
    renderProcessWires();
  };
  const labelToggle = $('simLabelToggleBtn');
  if (labelToggle) labelToggle.onclick = () => {
    app.showSecondaryLabels = !app.showSecondaryLabels;
    applySecondaryLabelVisibility();
  };
  if (backdrop) backdrop.onclick = () => setSimExpanded(false);
  if (viewport) {
    app.simInteraction = SimulationView.bindPan(viewport, {
      getPan: () => {
        applySimScale();
        const camera = getSimCamera();
        return camera.geometry ? camera.frame() : { x: 0, y: 0 };
      },
      onPan: (pan) => { getSimCamera().panTo(pan); applySimScale(); },
    });
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        app.simInteraction?.cancel();
        applySimScale();
      }).observe(viewport);
    }
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.querySelector('.sim-panel')?.classList.contains('expanded')) setSimExpanded(false);
  });
  applySecondaryLabelVisibility();
  applySimScale();
  requestAnimationFrame(renderProcessWires);
}

async function startSimulation() {
  const state = app.state || {};
  const rawLoops = Array.isArray(state.loops) ? state.loops : [];
  const loopCount = Number(state.nLoop || state.loops || rawLoops.length || (Array.isArray(state.loopParams) ? state.loopParams.length : 0) || 0);
  const rawCasc = Array.isArray(state.cascades) ? state.cascades : [];
  const cascCount = Number(state.nCasc || state.cascades || rawCasc.length || (Array.isArray(state.cascadeParams) ? state.cascadeParams.length : 0) || 0);
  const hasLoop = loopCount > 0;
  const hasCascade = cascCount > 0;
  const hasActuator = manualTargets().some((target) => Number(state[target.valueOf] ?? state[target.key] ?? 0) > 0);
  if (!hasLoop && !hasCascade) {
    toast('请先搭建回路，或至少设置泵/阀门手操值');
    return;
  }
  if (!hasActuator) {
    toast('请先设置泵/阀门手操值');
    return;
  }
  await sendCommand('START');
}

function wireStudentControls() {
  document.addEventListener('input', markParameterDirty, true);
  wireCurveControls();
  wireSimControls();
  wireProjectControls();
  $('startBtn').onclick = () => startSimulation().catch((e) => toast(e.message));
  $('pauseBtn').onclick = () => sendCommand('PAUSE').catch((e) => toast(e.message));
  $('resetBtn').onclick = () => sendCommand('RESET').then(() => clearParameterDirty()).catch((e) => toast(e.message));
  $('presetBtn').onclick = () => sendCommand('PRESET').catch((e) => toast(e.message));
  $('highScoreBtn').onclick = async () => {
    try {
      await sendCommand('HIGH_SCORE');
    } catch (e) { toast(e.message); }
  };
  $('applyManualBtn').onclick = async () => {
    try {
      const targets = [];
      for (const target of manualTargets()) {
        const input = $(target.id);
        if (!input || input.disabled) continue;
        const command = target.cmd === 'PUMP'
          ? (value) => 'SET_PUMP ' + value
          : (target.cmd === 'FUEL'
            ? (value) => 'SET_FUEL ' + value
            : (target.cmd === 'INLET'
              ? (value) => 'SET_INLET_TEMP ' + value
              : (value) => 'SET_VALVE ' + Number(target.mv) + ' ' + value));
        targets.push({ input, label: target.label, command, min: target.min ?? 0, max: target.max ?? 100 });
      }
      const values = targets.map((target) => {
        const value = inputValue(target.input, target.label);
        if (value < target.min || value > target.max) {
          throw new Error(`${target.label}必须在 ${target.min}～${target.max} 之间`);
        }
        return value;
      });
      for (let i = 0; i < targets.length; i += 1) {
        await sendCommand(targets[i].command(values[i]));
        delete targets[i].input.dataset.dirty;
      }
      toast('手操参数已应用');
    } catch (e) { toast(e.message); }
  };
  $('biasBtn').onclick = () => sendCommand(`SET_BIAS ${app.state?.bias ? 0 : 1}`).catch((e) => toast(e.message));
  // —— 评分系统开关：关闭时才能改评分细则 ——
  const scoreSystemToggle = $('scoreSystemToggle');
  const scoreCfgBox = $('teacherScoreConfig');
  const isScoreSysOn = () => {
    const v = app.cloudSettings && app.cloudSettings.scoreSystemOn;
    return v === '1' || v === 1 || v === true;
  };
  const refreshScoreConfigLock = () => {
    const on = isScoreSysOn();
    const hint = $('scoreSystemHint');
    if (hint) hint.textContent = on ? '评分系统已开启，细则锁定（请先关闭再改）' : '关闭时才能修改评分细则';
    if (scoreSystemToggle) {
      scoreSystemToggle.textContent = on ? '评分系统：开' : '评分系统：关';
      scoreSystemToggle.classList.toggle('on', !!on);
    }
    if (!scoreCfgBox) return;
    scoreCfgBox.querySelectorAll('input, button').forEach((el) => {
      if (el.id === 'scoreSystemToggle') return;
      el.disabled = !!on;
    });
  };
  if (scoreSystemToggle) {
    scoreSystemToggle.onclick = async () => {
      try {
        const next = !isScoreSysOn();
        const body = { scoreSystemOn: next ? '1' : '0' };
        const ret = await api('/api/teacher/settings', { method: 'POST', body: JSON.stringify(body) });
        if (ret && ret.settings) app.cloudSettings = ret.settings;
        app.cloudSettings = Object.assign({}, app.cloudSettings || {}, body);
        if (next) await sendCommand('SCORE_MODE 1');
        else await sendCommand('SCORE_MODE 0');
        refreshScoreConfigLock();
        toast(next ? '评分系统已开启，细则已锁定' : '评分系统已关闭，可修改评分细则');
      } catch (e) { toast(e.message, true); }
    };
  }
  // 从设置恢复开关状态（异步，不阻塞）
  api('/api/projects').then((st) => {
    if (st && st.settings) {
      app.cloudSettings = st.settings;
      refreshScoreConfigLock();
    }
  }).catch(() => refreshScoreConfigLock());

  // 评分配置：先选对象/方案，再只显示对应字段
  const modelId0 = (() => {
    try { return (modelSpec && modelSpec().modelId) || 'tank'; } catch { return 'tank'; }
  })();
  app.scoreObj = app.scoreObj || (modelId0 === 'hx' ? 'hx' : 'tank');
  app.scoreMode = app.scoreMode || 'unit';
  const scoreObjButtons = () => Array.from(document.querySelectorAll('#scoreObjPick [data-score-obj]'));
  const scoreModeButtons = () => Array.from(document.querySelectorAll('#scoreModePick [data-score-mode]'));
  const refreshScoreFields = () => {
    const obj = app.scoreObj;
    const mode = app.scoreMode;
    document.querySelectorAll('#teacherScoreConfig .score-fields').forEach((el) => {
      const o = el.getAttribute('data-obj') || obj;
      const m = el.getAttribute('data-mode') || mode;
      const objOk = (o === '*' || o === obj);
      const modeOk = (m === mode);
      el.classList.toggle('active', objOk && modeOk);
    });
    scoreObjButtons().forEach((b) => b.classList.toggle('active', b.getAttribute('data-score-obj') === obj));
    scoreModeButtons().forEach((b) => b.classList.toggle('active', b.getAttribute('data-score-mode') === mode));
  };
  const loadScoreTankSp = () => {
    const idx = Number($('scoreTankPick')?.value || 0);
    const src = $(`scoreSp${idx + 1}`);
    const view = $('scoreSpTank');
    if (view && src && document.activeElement !== view) {
      view.value = src.value || '50';
    }
  };
  const storeScoreTankSp = () => {
    const idx = Number($('scoreTankPick')?.value || 0);
    const view = $('scoreSpTank');
    const dst = $(`scoreSp${idx + 1}`);
    if (view && dst) dst.value = view.value;
  };
  scoreObjButtons().forEach((b) => {
    b.onclick = () => {
      app.scoreObj = b.getAttribute('data-score-obj');
      refreshScoreFields();
    };
  });
  scoreModeButtons().forEach((b) => {
    b.onclick = () => {
      app.scoreMode = b.getAttribute('data-score-mode');
      refreshScoreFields();
      // 与顶部「单罐评分 / 系统评分」同步
      const sys = app.scoreMode === 'sys';
      if (sys && $('scoreSystemBtn')) $('scoreSystemBtn').click();
      if (!sys && $('scoreTankBtn')) $('scoreTankBtn').click();
    };
  });
  const tankPick = $('scoreTankPick');
  if (tankPick) {
    tankPick.onchange = () => loadScoreTankSp();
  }
  const spTank = $('scoreSpTank');
  if (spTank) {
    spTank.oninput = () => storeScoreTankSp();
    spTank.onchange = () => storeScoreTankSp();
  }
  app.refreshScoreFields = refreshScoreFields;
  refreshScoreFields();
  loadScoreTankSp();

  const scoreApply = $('scoreApplyBtn');
  if (scoreApply) {
    scoreApply.onclick = async () => {
      try {
        const du = Number($('scoreDurUnit')?.value || 480);
        const ds = Number($('scoreDurSys')?.value || 1500);
        const bt = Number($('scoreBandTank')?.value || 2);
        const bh = Number($('scoreBandHx')?.value || 5);
        const da = Number($('scoreDistAt')?.value || 300);
        const dm = Number($('scoreDistMv')?.value ?? 3);
        const dd = Number($('scoreDistDelta')?.value ?? -20);
        // 单对象 / 系统 分开配置（对象字段常驻 DOM，隐藏面板值仍在）
        storeScoreTankSp();
        const uSp1 = Number($('scoreSp1')?.value || 50);
        const uSp2 = Number($('scoreSp2')?.value || 50);
        const uSp3 = Number($('scoreSp3')?.value || 50);
        const uSpHx = Number($('scoreSpHx')?.value || 400);
        const uBandTank = bt;
        const uBandHx = bh;
        const sSp1 = Number($('sysSp1')?.value || uSp1);
        const sSp2 = Number($('sysSp2')?.value || uSp2);
        const sSp3 = Number($('sysSp3')?.value || uSp3);
        const sSpHx = Number($('sysSpHx')?.value || uSpHx);
        const sBandTank = Number($('sysBandTank')?.value || bt);
        const sBandHx = Number($('sysBandHx')?.value || bh);
        const initTempHx = Number($('scoreInitTempHx')?.value || 400);
        await api('/api/teacher/settings', { method: 'POST', body: JSON.stringify({
          scoreConfig: {
            initTempHx,
            durationUnit: du, durationSystem: ds,
            bandTank: uBandTank, bandHx: uBandHx,
            sysBandTank: sBandTank, sysBandHx: sBandHx,
            disturbAt: da, disturbMv: dm, disturbDelta: dd,
            sp1: uSp1, sp2: uSp2, sp3: uSp3, spHx: uSpHx,
            sysSp1: sSp1, sysSp2: sSp2, sysSp3: sSp3, sysSpHx: sSpHx,
          },
        })});
        // SCORE_CFG：单对象限时/带宽 + 系统限时/系统带宽（扰动）
        await sendCommand(`SCORE_CFG ${du} ${ds} ${uBandTank} ${uBandHx} ${da} ${dm} ${dd}`);
        // 当前若为系统模式，再下发系统 SP/带宽；否则下发单对象 SP/带宽
        const modeNow = Number(app.state?.score?.mode || app.state?.scoreMode || 0);
        if (modeNow === 2) {
          await sendCommand(`SCORE_CFG ${du} ${ds} ${sBandTank} ${sBandHx} ${da} ${dm} ${dd}`);
          await sendCommand(`SET_SP 0 ${sSp1}`);
          await sendCommand(`SET_SP 1 ${sSp2}`);
          await sendCommand(`SET_SP 2 ${sSp3}`);
          await sendCommand(`SET_PVX_SP 0 ${sSpHx}`);
          const initTemp2 = Number($('scoreInitTempHx')?.value || 400);
          await sendCommand(`SET_INIT_TEMP ${initTemp2}`);
        } else {
          await sendCommand(`SET_SP 0 ${uSp1}`);
          await sendCommand(`SET_SP 1 ${uSp2}`);
          await sendCommand(`SET_SP 2 ${uSp3}`);
          await sendCommand(`SET_PVX_SP 0 ${uSpHx}`);
        const initTemp = Number($('scoreInitTempHx')?.value || 400);
        await sendCommand(`SET_INIT_TEMP ${initTemp}`);
        }
        toast('单对象 / 系统 评分配置已应用');
      } catch (e) { toast(e.message, true); }
    };
  }
  $('clearLoopsBtn').onclick = async () => {
    try {
      if (Number(app.state?.mode || 0) === 1) await sendCommand('CASC_CLEAR');
      await sendCommand('LOOP_CLEAR');
      toast('当前方案回路已清空');
    } catch (e) { toast(e.message); }
  };
  $('cloudUploadBtn').onclick = () => uploadStudentCloud().catch((e) => toast(e.message));
  $('cloudRestoreBtn').onclick = () => restoreStudentCloud().catch((e) => toast(e.message));
  document.querySelectorAll('[data-scheme]').forEach((btn) => {
    btn.onclick = () => sendCommand(`SET_MODE ${btn.dataset.scheme}`).catch((e) => toast(e.message));
  });
  $('buildType').onchange = () => {
    const casc = $('buildType').value === 'casc';
    document.querySelectorAll('.casc-only').forEach((el) => el.classList.toggle('hidden', !casc));
    syncBuildPvOptions();
  };
  $('addLoopBtn').onclick = async () => {
    try {
      if ($('buildType').value === 'casc') {
        await sendCommand(`CASC_ADD ${Number($('buildMv').value)} ${Number($('buildPv').value)} ${Number($('buildInner').value)}`);
      } else {
        await sendCommand(`LOOP_ADD ${Number($('buildPv').value)} ${Number($('buildMv').value)}`);
      }
      toast('回路已添加');
    } catch (e) { toast(e.message, true); }
  };
  $('scoreOffBtn').onclick = () => sendCommand('SCORE_MODE 0').catch((e) => toast(e.message));
  $('scoreTankBtn').onclick = () => {
    app.scoreMode = 'unit';
    if (app.refreshScoreFields) app.refreshScoreFields();
    sendCommand('SCORE_MODE 1').catch((e) => toast(e.message));
  };
  $('scoreSystemBtn').onclick = () => {
    app.scoreMode = 'sys';
    if (app.refreshScoreFields) app.refreshScoreFields();
    sendCommand('SCORE_MODE 2').catch((e) => toast(e.message));
  };
  $('scoreStartBtn').onclick = async () => {
    try {
      const state = app.state || {};
      if (!Number(state.score?.mode || 0)) return toast('请先选择评分方案');
      if (state.running || Number(state.sim_time || 0) > 0.0001) return toast('请先回到冷态，再开始评分');
      if (!confirm('开始评分会清空回路与泵阀，并开始计时，是否继续？')) return;
      await sendCommand('SCORE_START');
      toast('评分已开始，配置已清空，请重新搭建回路或使用教师模板');
    } catch (e) { toast(e.message, true); }
  };
  document.querySelectorAll('[data-score-tank]').forEach((btn) => {
    btn.onclick = () => sendCommand(`SCORE_TANK ${Number(btn.dataset.scoreTank)}`).catch((e) => toast(e.message));
  });
  const flowMaxEl = $('flowYMax');
  if (flowMaxEl) {
    flowMaxEl.oninput = () => {
      app.flowYMax = normalizedFlowYMax(flowMaxEl.value);
      if (app.view === 'curves') scheduleStudentCharts();
    };
    flowMaxEl.onchange = () => {
      app.flowYMax = normalizedFlowYMax(flowMaxEl.value);
      flowMaxEl.value = app.flowYMax === null ? '' : String(app.flowYMax);
      if (app.view === 'curves') scheduleStudentCharts();
    };
  }
}

function wireProjectControls() {
  const slotSelect = $('projectSlot');
  if (slotSelect) {
    slotSelect.onchange = () => {
      app.projectSlot = Number(slotSelect.value) || 1;
      renderStudentCloudStatus();
    };
  }
  const saveCurrentButton = $('currentSaveBtn');
  if (saveCurrentButton) saveCurrentButton.onclick = () => saveCurrentState().catch((e) => toast(e.message));
  const restoreCurrentButton = $('currentRestoreBtn');
  if (restoreCurrentButton) restoreCurrentButton.onclick = () => restoreCurrentState().catch((e) => toast(e.message));
  const exportButton = $('projectExportBtn');
  if (exportButton) exportButton.onclick = () => exportCurrentProject().catch((e) => toast(e.message));
  const exportParamsCsv = $('exportParamsCsvBtn');
  if (exportParamsCsv) exportParamsCsv.onclick = () => exportStudentParameterCsv();
  const exportParamsExcel = $('exportParamsExcelBtn');
  if (exportParamsExcel) exportParamsExcel.onclick = () => exportStudentParameterExcel();
  const importInput = $('projectImportInput');
  if (importInput) importInput.onchange = () => importProjectFile(importInput.files?.[0]).catch((e) => toast(e.message));
}

function wireTeacherControls() {
  document.querySelectorAll('[data-teacher-curve-tab]').forEach((button) => {
    button.onclick = () => switchTeacherCurveTab(button.dataset.teacherCurveTab);
  });
  $('teacherCurveLatestBtn').onclick = () => resetCurveView(app.teacherCurve.active, app.teacherCurve);
  $('teacherCurveExportBtn').onclick = () => exportTeacherCurvePng();
  $('teacherAnnToggleBtn').onclick = () => {
    app.teacherCurve.showAnnotation = !app.teacherCurve.showAnnotation;
    syncAnnotationButton('teacherAnnToggleBtn', app.teacherCurve);
    drawTeacherChart();
  };
  wireCurveInteraction($('teacherChart'), app.teacherCurve);
  syncAnnotationButton('teacherAnnToggleBtn', app.teacherCurve);
  renderTeacherLegend();
  $('refreshTeacherBtn').onclick = () => loadTeacher().catch((e) => toast(e.message));
  $('exportTeacherParamsBtn').onclick = () => exportTeacherParameterCsv();
  $('toggleHxModelBtn').onclick = async () => {
    try {
      const next = !app.cloudSettings.openModels?.hx;
      const data = await api('/api/teacher/settings', { method: 'POST', body: JSON.stringify({ openModels: { hx: next } }) });
      app.cloudSettings = data.settings || app.cloudSettings;
      await loadTeacherCloudData();
      toast(next ? '已向学生开放换热器模型' : '已关闭学生换热器模型');
    } catch (e) { toast(e.message); }
  };
  $('toggleStudentUploadBtn').onclick = async () => {
    try {
      const next = !app.cloudSettings.allowStudentUpload;
      const data = await api('/api/teacher/settings', { method: 'POST', body: JSON.stringify({ allowStudentUpload: next }) });
      app.cloudSettings = data.settings || app.cloudSettings;
      await loadTeacherCloudData();
      toast(next ? '已开放学生保存上传' : '已关闭学生保存上传');
    } catch (e) { toast(e.message); }
  };
  $('restoreTeacherBackupBtn').onclick = () => restoreTeacherCloudBackup().catch((e) => toast(e.message));
  $('teacherClassFilter').onchange = async () => {
    app.teacherClassFilter = $('teacherClassFilter').value;
    app.selectedStudent = null;
    closeTeacherStudentStream();
    await loadTeacher().catch((e) => toast(e.message));
  };
  const teacherModelSelect = $('teacherModelFilter');
  if (teacherModelSelect) {
    teacherModelSelect.onchange = async () => {
      app.teacherModelFilter = teacherModelSelect.value || 'all';
      app.selectedStudent = null;
      app.teacherCloudSelectedStudents.clear();
      app.expandedTeacherParams.clear();
      closeTeacherStudentStream();
      openTeacherStream();
      await loadTeacher().catch((e) => toast(e.message));
      toast(`看板已切换为「${teacherModelLabel()}」`);
    };
  }
  $('cloudClassFilter').onchange = () => {
    app.teacherCloudClassFilter = $('cloudClassFilter').value;
    app.teacherCloudStudentFilter = '';
    app.teacherCloudSelectedStudents.clear();
    renderTeacherCloudFilters();
    renderTeacherCloudSubmissions();
  };
  const selectAllCloudStudents = $('selectAllCloudStudentsBtn');
  if (selectAllCloudStudents) selectAllCloudStudents.onclick = () => {
    const students = selectedCloudClass()?.students || [];
    app.teacherCloudSelectedStudents = new Set(students.map((student) => student.studentId));
    renderTeacherCloudSelection();
  };
  const clearCloudStudentSelection = $('clearCloudStudentSelectionBtn');
  if (clearCloudStudentSelection) clearCloudStudentSelection.onclick = () => {
    app.teacherCloudSelectedStudents.clear();
    renderTeacherCloudSelection();
  };
  const exportCloudZip = $('exportCloudZipBtn');
  if (exportCloudZip) exportCloudZip.onclick = () => exportTeacherCloudZip().catch((e) => toast(e.message));
  $('cloudStudentFilter').onchange = () => {
    app.teacherCloudStudentFilter = $('cloudStudentFilter').value;
    renderTeacherCloudSubmissions();
  };
  $('exportRecordsBtn').onclick = () => {
    window.location.href = `/api/teacher/export.csv?${teacherQueryParams()}`;
  };
  $('clearRecordsBtn').onclick = async () => {
    const classId = app.teacherClassFilter;
    const scope = classId ? app.roster.classes.find((item) => item.id === classId) : null;
    const message = classId ? `确定清空“${scope?.name || '当前筛选班级'}”的评分记录吗？` : '确定清空全部班级的评分记录吗？';
    if (!confirm(message)) return;
    try {
      await api('/api/teacher/clear', { method: 'POST', body: JSON.stringify({ classId }) });
      await loadRecords();
      toast('评分记录已清空');
    } catch (e) { toast(e.message); }
  };
}

async function refreshRosterAndTeacher() {
  await loadRoster();
  if (app.view === 'teacher') await loadTeacher();
}

function wireRosterControls() {
  $('createClassBtn').onclick = async () => {
    try {
      const result = await api('/api/teacher/classes', { method: 'POST', body: JSON.stringify({
        name: $('newClassName').value,
        code: $('newClassCode').value,
      }) });
      app.roster.selectedClassId = result.class.id;
      $('newClassName').value = '';
      $('newClassCode').value = '';
      await refreshRosterAndTeacher();
      toast('班级已创建');
    } catch (e) { toast(e.message); }
  };
  $('saveClassBtn').onclick = async () => {
    const selected = currentClass();
    if (!selected) return toast('请先选择班级');
    try {
      await api(`/api/teacher/classes/${encodeURIComponent(selected.id)}`, { method: 'PUT', body: JSON.stringify({
        name: $('rosterClassName').value,
        code: $('rosterClassCode').value,
        enabled: $('rosterClassEnabled').checked,
      }) });
      await refreshRosterAndTeacher();
      toast('班级设置已保存');
    } catch (e) { toast(e.message); }
  };
  $('deleteClassBtn').onclick = async () => {
    const selected = currentClass();
    if (!selected) return toast('请先选择班级');
    if (!confirm(`确定删除班级“${selected.name}”及其全部名单吗？`)) return;
    try {
      await api(`/api/teacher/classes/${encodeURIComponent(selected.id)}`, { method: 'DELETE', body: '{}' });
      app.roster.selectedClassId = null;
      await refreshRosterAndTeacher();
      toast('班级已删除');
    } catch (e) { toast(e.message); }
  };
  $('addStudentBtn').onclick = async () => {
    const selected = currentClass();
    if (!selected) return toast('请先选择班级');
    try {
      await api(`/api/teacher/classes/${encodeURIComponent(selected.id)}/students`, { method: 'POST', body: JSON.stringify({
        studentId: $('rosterStudentId').value,
        name: $('rosterStudentName').value,
      }) });
      $('rosterStudentId').value = '';
      $('rosterStudentName').value = '';
      await refreshRosterAndTeacher();
      toast('学生已添加');
    } catch (e) { toast(e.message); }
  };
  $('exportRosterBtn').onclick = () => {
    const selected = currentClass();
    if (selected) window.location.href = `/api/teacher/classes/${encodeURIComponent(selected.id)}/export.csv`;
  };
  $('rosterFileInput').onchange = async () => {
    const file = $('rosterFileInput').files?.[0];
    if (!file) return;
    try {
      const parsed = await parseRosterFile(file);
      $('rosterImportText').value = '';
      renderRosterImportPreview(parsed.rows, `${file.name} · ${parsed.sheetName}`);
      toast(`已识别 ${parsed.rows.length} 名学生`);
    } catch (e) {
      clearRosterImportFile(true);
      toast(e.message);
    }
  };
  $('clearRosterFileBtn').onclick = () => {
    clearRosterImportFile(true);
    toast('已清除文件');
  };
  $('rosterImportText').oninput = () => {
    if (app.rosterImportRows.length) clearRosterImportFile(true);
  };
  const importRoster = async (mode) => {
    const selected = currentClass();
    if (!selected) return toast('请先选择班级');
    try {
      const rows = getRosterImportRows();
      if (!rows.length) return toast('没有可导入的数据');
      if (mode === 'replace' && !confirm(`覆盖导入会替换“${selected.name}”的现有名单，继续吗？`)) return;
      const result = await api(`/api/teacher/classes/${encodeURIComponent(selected.id)}/import`, { method: 'POST', body: JSON.stringify({ rows, mode }) });
      $('rosterImportText').value = '';
      clearRosterImportFile(true);
      await refreshRosterAndTeacher();
      toast(`导入完成：新增 ${result.added}，更新 ${result.updated}`);
    } catch (e) { toast(e.message); }
  };
  $('importMergeBtn').onclick = () => importRoster('merge');
  $('importReplaceBtn').onclick = () => importRoster('replace');
  $('classRows').onclick = (event) => {
    const btn = event.target.closest('[data-class-select]');
    if (!btn) return;
    clearRosterImportFile(true);
    app.roster.selectedClassId = btn.dataset.classSelect;
    renderRoster();
  };
  $('rosterStudentRows').onclick = async (event) => {
    const selected = currentClass();
    if (!selected) return;
    const saveBtn = event.target.closest('[data-student-save]');
    if (saveBtn) {
      const row = saveBtn.closest('tr');
      const oldId = saveBtn.dataset.studentSave;
      try {
        await api(`/api/teacher/classes/${encodeURIComponent(selected.id)}/students/${encodeURIComponent(oldId)}`, { method: 'PUT', body: JSON.stringify({
          studentId: row.querySelector('input[data-student-id]').value,
          name: row.querySelector('input[data-student-name]').value,
          enabled: row.querySelector('input[data-student-enabled]').checked,
        }) });
        await refreshRosterAndTeacher();
        toast('学生已保存');
      } catch (e) { toast(e.message); }
      return;
    }
    const deleteBtn = event.target.closest('[data-student-delete]');
    if (deleteBtn) {
      const studentId = deleteBtn.dataset.studentDelete;
      if (!confirm(`确定删除学生 ${studentId} 吗？`)) return;
      try {
        await api(`/api/teacher/classes/${encodeURIComponent(selected.id)}/students/${encodeURIComponent(studentId)}`, { method: 'DELETE', body: '{}' });
        await refreshRosterAndTeacher();
        toast('学生已删除');
      } catch (e) { toast(e.message); }
    }
  };
}

function wireLogin() {
  document.querySelectorAll('.login-tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('.login-tab').forEach((x) => x.classList.toggle('active', x === tab));
      $('studentLoginForm').classList.toggle('hidden', tab.dataset.role !== 'student');
      $('teacherLoginForm').classList.toggle('hidden', tab.dataset.role !== 'teacher');
    };
  });
  $('studentLoginForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({
        role: 'student',
        studentId: $('studentId').value,
        name: $('studentName').value,
        classCode: $('classCode').value,
        model: $('studentModel')?.value || 'tank',
      })});
      $('loginError').textContent = '';
      await connectStudent();
    } catch (err) { $('loginError').textContent = err.message; }
  };
  $('teacherLoginForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ role: 'teacher', teacherCode: $('teacherCode').value, model: $('teacherModel')?.value || 'tank' }) });
      $('loginError').textContent = '';
      await connectTeacher();
    } catch (err) { $('loginError').textContent = err.message; }
  };
  $('logoutBtn').onclick = async () => {
    app.loggingOut = true;
    try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
    showLogin('');
  };
  window.addEventListener('pagehide', () => {
    if (!app.loggingOut && app.me?.role === 'student') {
      navigator.sendBeacon('/api/student/auto-save', new Blob(['{}'], { type: 'application/json' }));
    }
  });
  document.querySelectorAll('#mainTabs .tab').forEach((tab) => {
    tab.onclick = () => switchView(tab.dataset.view);
  });
  setInterval(() => {
    if (!$('loginView').classList.contains('hidden')) loadModelOptions().catch(() => {});
  }, 5000);
}

(async function boot() {
  rebuildSeriesIndex();
  renderSpecShell();
  await loadModelOptions().catch(() => {});
  wireLogin();
  wireStudentControls();
  wireTeacherControls();
  wireRosterControls();
  wirePidPanelControls();
  try {
    const me = await api('/api/me');
    app.me = me;
    showApp();
    if (me.role === 'teacher') await connectTeacher();
    else await connectStudent();
  } catch {
    showLogin('');
  }
})();
