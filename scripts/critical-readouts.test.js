'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { criticalReadouts } = require('../public/control-workspace');
const { fitFrame } = require('../public/control-workspace');
const { tankLevelGeometry } = require('../public/control-workspace');
const { pvReadout } = require('../public/control-workspace');
const fs = require('node:fs');
const path = require('node:path');

test('tank readouts retain model precision and percentage units', () => {
  const tags = ['h1','h2','h3'].map((key, index) => ({ key, label:`LI10${index + 1}(%)`, digits:2 }));
  assert.deepEqual(criticalReadouts('tank', tags, { h1:55.126, h2:0, h3:'31.8' }), [
    { key:'h1', label:'LI101', unit:'%', value:'55.13' },
    { key:'h2', label:'LI102', unit:'%', value:'0.00' },
    { key:'h3', label:'LI103', unit:'%', value:'31.80' },
  ]);
});
test('HX distinguishes inlet, outlet, teacher target and steam flow', () => {
  const tags = [
    { key:'ti1104', label:'TI1104 出口(℃)', digits:2 },
    { key:'sp', label:'出口给定(℃)', digits:2 },
    { key:'ti1103', label:'TI1103 入口(℃)', digits:2 },
    { key:'fi1105', label:'FI1105(kg/s)', digits:3 },
  ];
  const rows = criticalReadouts('hx', tags, { ti1104:420, sp:450, ti1103:400, fi1105:1.2354 });
  assert.deepEqual(rows.map(row => [row.key, row.unit, row.value]), [
    ['ti1104','℃','420.00'], ['sp','℃','450.00'], ['ti1103','℃','400.00'], ['fi1105','kg/s','1.235'],
  ]);
});
test('missing, empty and invalid measurements are never presented as zero', () => {
  for (const raw of [undefined, null, '', ' ', false, [], NaN, Infinity, 'bad']) {
    assert.equal(criticalReadouts('tank', [], { h1:raw })[0].value, '—');
  }
  assert.equal(criticalReadouts('tank', [], null)[0].value, '—');
});
test('a model switch rebuilds the presentation from that model only', () => {
  assert.deepEqual(criticalReadouts('hx', [], { h1:65 }).map(row => row.key), ['ti1104','sp','ti1103','fi1105']);
  assert.ok(criticalReadouts('hx', [], { h1:65 }).every(row => row.value === '—'));
});
test('the complete process world fits narrow, sidebar and fullscreen viewports', () => {
  for (const viewport of [{ width:326, height:340 }, { width:762, height:340 }, { width:1480, height:620 }]) {
    const world = { width:1100, height:470 };
    const frame = fitFrame(viewport, world, 1);
    assert.ok(frame.x >= 0 && frame.y >= 0);
    assert.ok(frame.x + world.width * frame.scale <= viewport.width + 1e-8);
    assert.ok(frame.y + world.height * frame.scale <= viewport.height + 1e-8);
  }
});
test('each tank measurement id belongs to exactly one visible metrics element', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  for (const id of ['mL1','mL2','mL3','mQin','mQ12','mQ23','mQout','mPi']) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
  }
});
test('tank illustration tracks live levels instead of placeholder fill heights', () => {
  assert.deepEqual(tankLevelGeometry(0), { y:240, height:0 });
  assert.deepEqual(tankLevelGeometry(50), { y:180, height:60 });
  assert.deepEqual(tankLevelGeometry(100), { y:120, height:120 });
  assert.deepEqual(tankLevelGeometry(125), tankLevelGeometry(100));
  for (const missing of [null, undefined, '', 'bad', NaN]) {
    assert.deepEqual(tankLevelGeometry(missing), { y:240, height:0 });
  }
});
test('manual cascade PV uses live model measurements instead of the last PID calculation', () => {
  const state = { ti1104:400, fi1105:21.554, outerPvValue:0, innerPvValue:0 };
  assert.equal(pvReadout({ stateKey:'ti1104', unit:'℃' }, state, 1), '400.0 ℃');
  assert.equal(pvReadout({ stateKey:'fi1105', unit:'kg/s' }, state, 2), '21.55 kg/s');
  assert.equal(pvReadout({ stateKey:'h1', unit:'%' }, { h1:0 }, 1), '0.0 %');
});
test('unavailable loop measurements display a dash with no fabricated zero', () => {
  for (const raw of [null, undefined, '', 'bad']) {
    assert.equal(pvReadout({ stateKey:'h1', unit:'%' }, { h1:raw }, 1), '—');
  }
});
