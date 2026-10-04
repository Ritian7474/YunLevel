(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProcessDeviceControls = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function finite(raw, label) {
    if (raw === null || raw === undefined || String(raw).trim() === '' || !Number.isFinite(Number(raw))) throw new Error(`${label}必须是有效数字`);
    return Number(raw);
  }
  function integral(raw) {
    if (/^(inf|∞)$/i.test(String(raw).trim())) return -1;
    const value = finite(raw, 'Ti');
    if (value === 0) throw new Error('Ti 不能为 0；关闭积分请填 inf');
    return value;
  }
  function manualCommand(target, raw) {
    const value = finite(raw, target.label);
    const min = target.min ?? 0, max = target.max ?? 100;
    if (value < min || value > max) throw new Error(`${target.label}必须在 ${min}～${max} 之间`);
    if (target.cmd === 'PUMP') return `SET_PUMP ${value}`;
    if (target.cmd === 'INLET') return `SET_INLET_TEMP ${value}`;
    if (target.cmd === 'FUEL') return `SET_FUEL ${value}`;
    if (target.cmd === 'VALVE' && Number.isInteger(target.mv)) return `SET_VALVE ${target.mv} ${value}`;
    throw new Error('设备没有可用的手操命令');
  }
  // Flag/output changes deliberately start from APPLIED state, not PID drafts.
  function pidCommand(entry, which, changes = {}) {
    const v = entry.value, loop = entry.kind === 'loop', prefix = loop ? '' : which;
    if (!loop && !['outer','inner'].includes(which)) throw new Error('请选择主环或副环');
    const key = name => prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name;
    const kp = finite(changes.kp ?? v[key('kp')], 'Kp');
    const ti = integral(changes.ti ?? v[key('ti')]);
    const td = finite(changes.td ?? v[key('td')], 'Td');
    if (kp < 0 || td < 0) throw new Error('Kp、Td 不能为负数');
    const manual = changes.manual ?? (v[key('manual')] ? 1 : 0);
    const action = changes.action ?? v[key('action')];
    const out = finite(changes.out ?? (loop ? v.manualOut : v[key('out')]), '手动输出');
    if (out < 0 || out > 100) throw new Error('手动输出必须在 0～100 之间');
    return `SET_PID ${loop ? 'loop' : which} ${entry.index} ${kp} ${ti} ${td} ${action} ${manual} ${out}`;
  }
  function canWrite(account) { return !!account && ['teacher','student'].includes(account.role) && !account.viewOnly; }
  function create(options) {
    const doc = options.document;
    const ctx = () => options.getContext();
    const input = (entry, key) => doc.querySelector(`[data-${entry.kind}="${entry.index}"][data-field="${key}"]`);
    function describe(device, loopKey) {
      const current = ctx();
      const entry = current.entries.find(item => item.key === loopKey);
      const root = entry ? doc.querySelector(`[data-${entry.kind === 'loop' ? 'loop' : 'casc'}-card="${entry.index}"]`) : doc.getElementById('manualControls');
      const field = (key, label, group = '', disable = false) => {
        const source = input(entry, key);
        return { key,label,group,source,disabled:disable || !canWrite(current.account),
          policy:source && options.policy(source) };
      };
      const actions = [];
      let fields = [];
      if (entry) {
        const v = entry.value, teacher = current.account?.role === 'teacher';
        if (entry.kind === 'loop') {
          fields = [field('sp', `SP ${current.pvUnit(v.pv)}`, '', !teacher || !!current.state?.score?.active),
            field('kp','Kp'),field('ti','Ti (s)'),field('td','Td (s)'),field('manualOut','手动输出 %','',!v.manual)];
          actions.push({ id:'mode-loop',label:v.manual ? '投自动' : '投手动' });
          actions.push({ id:'output-loop',label:'应用手动输出',disabled:!v.manual });
        } else {
          fields = [field('outerSp',`主环 SP ${current.pvUnit(v.outer)}`,'主环',!teacher || !!current.state?.score?.active),
            field('outerKp','Kp','主环'),field('outerTi','Ti (s)','主环'),field('outerTd','Td (s)','主环'),
            field('innerKp','Kp','副环'),field('innerTi','Ti (s)','副环'),field('innerTd','Td (s)','副环'),
            field('innerManualOut','阀门手动输出 %','副环',!v.innerManual)];
          actions.push({ id:'mode-outer',label:v.outerManual ? '主环投自动' : '主环投手动' },
            { id:'mode-inner',label:v.innerManual ? '副环投自动' : '副环投手动' });
          actions.push({ id:'output-inner',label:'应用阀门手动输出',disabled:!v.innerManual });
        }
        actions.unshift({ id:'pid',label:'应用参数',primary:true });
      } else if (device.manual) {
        const source = doc.getElementById(device.manual);
        fields = [{ key:'manual', label:source?.closest('label')?.childNodes[0]?.textContent || device.name,
          source, policy:source && options.policy(source), disabled:!canWrite(current.account) }];
        actions.push({ id:'manual',label:'应用此设备',primary:true });
      }
      return { root,fields:fields.filter(item => item.source),actions:actions.map(action => ({ ...action,disabled:!!action.disabled || !canWrite(current.account) })),
        canBuild:canWrite(current.account) && device.pv !== undefined && !entry,
        entry, readonly:current.account?.viewOnly ? '观察窗口仅可查看。' : current.account?.role === 'student' ? 'SP 由教师设定；PID 与手操可调。' : '' };
    }
    async function act(device, loopKey, action) {
      const current = ctx(), model = current.model, account = current.account;
      if (!canWrite(account)) throw new Error('当前账号只可查看');
      const descriptor = describe(device, loopKey), entry = descriptor.entry;
      const root = descriptor.root;
      const button = root?.querySelector(entry ? `[data-${entry.kind}-apply]` : '#applyManualBtn');
      if (!button) throw new Error('操作对象已变化，请重新选择设备');
      const used = [];
      let commands;
      const read = key => {
        const source = input(entry, key);
        if (!source || !source.isConnected) throw new Error('回路已变化，请重新选择');
        used.push(source); return source.value;
      };
      if (action === 'manual' && !entry) {
        const target = current.manualTargets.find(item => item.id === device.manual);
        const source = doc.getElementById(device.manual);
        if (!source || source.disabled || source.readOnly) throw new Error('设备已由回路控制，请通过回路操作');
        used.push(source); commands = [manualCommand(target, source.value)];
      } else if (entry && action.startsWith('mode-')) {
        const which = action.slice(5), v = entry.value;
        const manual = entry.kind === 'loop' ? v.manual : v[which + 'Manual'];
        commands = [pidCommand(entry, which, { manual:manual ? 0 : 1 })];
      } else if (entry && action.startsWith('output-')) {
        const which = action.slice(7);
        if (!(entry.kind === 'loop' ? entry.value.manual : entry.value.innerManual)) throw new Error('请先明确切到手动，再应用输出');
        commands = [pidCommand(entry, which, { out:read(entry.kind === 'loop' ? 'manualOut' : 'innerManualOut') })];
      } else if (entry && action === 'pid') {
        const v = entry.value; commands = [];
        const spKey = entry.kind === 'loop' ? 'sp' : 'outerSp';
        if (account.role === 'teacher' && !current.state?.score?.active) {
          const sp = finite(read(spKey), 'SP');
          if (sp !== Number(v[spKey])) commands.push(`${entry.kind === 'loop' ? 'SET_SP' : 'SET_PVX_SP'} ${entry.kind === 'loop' ? v.pv : v.outer} ${sp}`);
        }
        if (entry.kind === 'loop') commands.push(pidCommand(entry, 'loop', { kp:read('kp'),ti:read('ti'),td:read('td'),out:read('manualOut') }));
        else {
          commands.push(pidCommand(entry, 'outer', { kp:read('outerKp'),ti:read('outerTi'),td:read('outerTd') }),
            pidCommand(entry, 'inner', { kp:read('innerKp'),ti:read('innerTi'),td:read('innerTd'),out:read('innerManualOut') }));
        }
      } else throw new Error('操作对象已变化，请重新选择设备');
      const check = () => {
        const latest = ctx();
        if (latest.model !== model || latest.account !== account || !canWrite(latest.account)) throw new Error('会话或控制权已变化，请重新操作');
        if (entry && !latest.entries.some(item => item.key === entry.key && item.index === entry.index)) throw new Error('回路已变化，请重新选择');
        if (entry && (!root.isConnected || doc.querySelector(`[data-${entry.kind === 'loop' ? 'loop' : 'casc'}-card="${entry.index}"]`) !== root)) throw new Error('回路已变化，请重新选择');
        if (used.some(source => !source.isConnected)) throw new Error('参数表单已变化，请重新选择设备');
        if (!entry && doc.getElementById(device.manual)?.disabled) throw new Error('设备已由回路控制，请通过回路操作');
      };
      return options.feedback.submit(button, async () => { for (const command of commands) { check(); await options.send(command); } }, { inputs:used });
    }
    return { describe, act };
  }
  return { finite,integral,manualCommand,pidCommand,canWrite,create };
});
