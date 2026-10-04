'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { manualCommand,pidCommand,create } = require('../public/process-device-controls');
const { applyDraft } = require('../public/parameter-feedback');
const { devices } = require('../public/process-devices');
const { entries } = require('../public/control-workspace');
const loop = () => ({ mv:1,pv:0,sp:50,kp:0.5,ti:-1,td:60,action:1,manual:false,manualOut:17 });
const cascade = () => ({ mv:2,outer:0,inner:1,outerSp:450,outerKp:0.3,outerTi:60,outerTd:0,
  innerKp:0.5,innerTi:-1,innerTd:5,outerManual:false,innerManual:true,outerAction:-1,innerAction:1,outerOut:30,innerOut:23 });
function fixture(role = 'teacher', casc = false) {
  const state = { loops:casc ? [] : [loop()],cascades:casc ? [cascade()] : [],score:{ active:false } };
  let account = { role, viewOnly:false }, model = casc ? 'hx' : 'tank';
  const fields = new Map();
  const field = value => ({ value:String(value),type:'number',dataset:{ dirty:'1' },isConnected:true,disabled:false,readOnly:false,
    closest:() => ({ childNodes:[{ textContent:'手操 %' }] }) });
  const values = casc ? { outerSp:450,outerKp:0.3,outerTi:'inf',outerTd:0,innerKp:0.5,innerTi:'inf',innerTd:5,innerManualOut:23 }
    : { sp:65,kp:0.9,ti:'inf',td:90,manualOut:17 };
  Object.entries(values).forEach(([key,value]) => fields.set(key, field(value)));
  fields.set('pumpInput', field(42)); fields.set('fv104Input', field(88));
  const button = {};
  const root = { isConnected:true,querySelector:() => button };
  const doc = { querySelector:selector => {
    if (selector.includes('-card=')) return root;
    return fields.get(/data-field="([^"]+)"/.exec(selector)?.[1]);
  }, getElementById:id => id === 'manualControls' ? root : fields.get(id) };
  const commands = [], scopes = [];
  let send = async cmd => commands.push(cmd);
  const controls = create({ document:doc, getContext:() => ({ model,account,state,
    entries:entries(state.loops,state.cascades),pvUnit:() => casc ? '℃' : '%',
    manualTargets:[{ id:'pumpInput',cmd:'PUMP',label:'P101' },{ id:'fv104Input',cmd:'VALVE',mv:3,label:'FV104' }] }),
    policy:() => ({ min:0,max:100,step:1 }),send:cmd => send(cmd),
    feedback:{ async submit(_, action, { inputs }) { scopes.push(inputs); await applyDraft(inputs, action); return { ok:true }; } } });
  return { state,fields,controls,commands,scopes,root,key:entries(state.loops,state.cascades)[0].key,
    setSend(fn) { send = fn; },observe() { account.viewOnly = true; },switchModel() { model = 'hx'; } };
}
test('manual commands validate boundaries and cannot manufacture an unknown command', () => {
  assert.equal(manualCommand({ cmd:'VALVE',mv:2,label:'FV1105' }, '23.5'), 'SET_VALVE 2 23.5');
  assert.equal(manualCommand({ cmd:'INLET',min:250,max:650,label:'TI1103' }, 400), 'SET_INLET_TEMP 400');
  for (const raw of ['',NaN,Infinity,-1,101]) assert.throws(() => manualCommand({ cmd:'PUMP',label:'P101' }, raw));
  assert.throws(() => manualCommand({ cmd:'QUIT',label:'未知设备' }, 10));
});
test('applying one free pump submits only that device and keeps another valve draft', async () => {
  const f = fixture(); const pump = devices('tank')[0];
  await f.controls.act(pump,null,'manual');
  assert.deepEqual(f.commands, ['SET_PUMP 42']);
  assert.deepEqual(f.scopes[0], [f.fields.get('pumpInput')]);
  assert.equal(f.fields.get('pumpInput').dataset.dirty, undefined);
  assert.equal(f.fields.get('fv104Input').dataset.dirty, '1');
});
test('mode switches use applied parameters and do not apply or clear PID/output drafts', async () => {
  const f = fixture();
  await f.controls.act(devices('tank')[3],f.key,'mode-loop');
  assert.deepEqual(f.commands, ['SET_PID loop 0 0.5 -1 60 1 1 17']);
  assert.deepEqual(f.scopes[0], []);
  assert.equal(f.fields.get('kp').value, '0.9');
  assert.equal(f.fields.get('kp').dataset.dirty, '1');
  assert.equal(f.fields.get('manualOut').dataset.dirty, '1');
});
test('student PID application never sends SP; teacher SP application respects an active assessment', async () => {
  for (const role of ['student','teacher']) {
    const f = fixture(role);
    if (role === 'teacher') f.state.score.active = true;
    await f.controls.act(devices('tank')[2], f.key, 'pid');
    assert.deepEqual(f.commands, ['SET_PID loop 0 0.9 -1 90 1 0 17']);
    assert.equal(f.fields.get('sp').dataset.dirty, '1');
    assert.equal(f.controls.describe(devices('tank')[2], f.key).fields[0].disabled, true);
  }
});
test('cascade valve output applies only to the inner loop using applied PID and keeps main/inner drafts', async () => {
  const f = fixture('student',true); f.fields.get('innerManualOut').value = '37';
  f.fields.get('innerKp').value = '2.5';
  await f.controls.act(devices('hx').find(item => item.id === 'FV1105'), f.key, 'output-inner');
  assert.deepEqual(f.commands, ['SET_PID inner 0 0.5 -1 5 1 1 37']);
  assert.equal(f.fields.get('innerKp').dataset.dirty, '1');
  assert.equal(f.fields.get('outerSp').dataset.dirty, '1');
  assert.equal(f.fields.get('innerManualOut').dataset.dirty, undefined);
});
test('automatic output, observation and occupied direct manual overrides are refused', async () => {
  const f = fixture(); const device = devices('tank')[3];
  await assert.rejects(f.controls.act(device,f.key,'output-loop'), /切到手动/);
  f.observe(); await assert.rejects(f.controls.act(device,f.key,'pid'), /只可查看/);
  assert.equal(f.commands.length, 0);
  assert.ok(f.controls.describe(device,f.key).actions.every(action => action.disabled));
  const g = fixture(); g.fields.get('pumpInput').disabled = true;
  await assert.rejects(g.controls.act(devices('tank')[0],null,'manual'), /回路控制/);
});
test('an intermediate reply that deletes or reindexes the selected loop cannot target a replacement', async () => {
  const f = fixture();
  f.setSend(async cmd => { f.commands.push(cmd); f.state.loops = [{ ...loop(),mv:3 }]; });
  await assert.rejects(f.controls.act(devices('tank')[2],f.key,'pid'), /回路已变化/);
  assert.deepEqual(f.commands, ['SET_SP 0 65']);
  assert.equal(f.fields.get('kp').dataset.dirty, '1');
  assert.equal(f.fields.get('sp').dataset.dirty, '1');
});
test('model switches and control loss during a multi-command action reject the remaining commands', async () => {
  for (const change of ['switchModel','observe']) {
    const f = fixture(); f.setSend(async cmd => { f.commands.push(cmd); f[change](); });
    await assert.rejects(f.controls.act(devices('tank')[2],f.key,'pid'), /控制权已变化/);
    assert.equal(f.commands.length, 1);
  }
});
test('a deleted and recreated identical loop cannot receive the remainder of an old apply', async () => {
  const f = fixture();
  f.setSend(async cmd => { f.commands.push(cmd); f.root.isConnected = false; });
  await assert.rejects(f.controls.act(devices('tank')[2],f.key,'pid'), /回路已变化/);
  assert.equal(f.commands.length, 1);
  assert.equal(f.fields.get('kp').dataset.dirty, '1');
});
test('mode actions keep a stable control list while automatic outputs remain disabled', () => {
  const f = fixture(); const device = devices('tank')[3];
  const before = f.controls.describe(device,f.key).actions;
  assert.equal(before.find(action => action.id === 'output-loop').disabled, true);
  f.state.loops[0].manual = true;
  const after = f.controls.describe(device,f.key).actions;
  assert.deepEqual(before.map(action => action.id), after.map(action => action.id));
  assert.equal(after.find(action => action.id === 'output-loop').disabled, false);
});
test('typed infinity keeps the existing PID contract and invalid parameters fail before commands', () => {
  assert.match(pidCommand({ kind:'loop',index:0,value:loop() }, 'loop', { ti:'∞' }), /0\.5 -1 60/);
  assert.throws(() => pidCommand({ kind:'loop',index:0,value:loop() }, 'loop', { ti:0 }), /Ti/);
  assert.throws(() => pidCommand({ kind:'casc',index:0,value:cascade() }, 'invalid'), /主环或副环/);
});
