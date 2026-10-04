'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { devices, related, reading, place, hitBox, nearestHit } = require('../public/process-devices');
const { entries } = require('../public/control-workspace');
test('visible devices map to model-specific single and cascade loops without inventing HX instruments', () => {
  const tank = devices('tank'); const hx = devices('hx');
  assert.equal(tank.length, 8); assert.equal(hx.length, 7);
  assert.ok(!hx.some(item => ['FV1101','HV1102'].includes(item.id)));
  const list = entries([{ mv:1,pv:0 }, { mv:2,pv:1 }], [{ mv:0,outer:0,inner:1 }]);
  assert.deepEqual(related(tank.find(item => item.id === 'FV102'), list).map(item => item.key), ['loop:1:0:0']);
  assert.equal(related(tank.find(item => item.id === 'T1'), list).length, 2);
  assert.equal(related(hx.find(item => item.id === 'FI1102'), list)[0].kind, 'casc');
  assert.equal(related(tank[0], list).length, 0);
});
test('both models show the real reading and unit; missing, blank and invalid data never become zero', () => {
  for (const model of ['tank','hx']) for (const device of devices(model)) {
    assert.equal(reading(device, { [device.key]:0 }), device.unit === 'kg/s' ? '0.00 kg/s' : `0.0 ${device.unit}`);
    for (const raw of [null, undefined, '', ' ', NaN, Infinity]) assert.equal(reading(device, { [device.key]:raw }), '—');
  }
});
test('device cards avoid the desktop edges and respect a shifted visual viewport', () => {
  const result = place({ left:1000,right:1044,top:700 }, { width:340,height:400 }, { width:1100,height:724,top:0 });
  assert.ok(result.left >= 12 && result.left + 340 <= 1088);
  assert.equal(result.top, 312);
  const keyboard = place({ left:30,right:70,top:50 }, { width:340,height:250 }, { width:1000,height:300,top:100 });
  assert.ok(keyboard.top >= 112 && keyboard.top + 250 <= 388);
});
test('device targets remain 44 screen pixels at fit/zoom while keeping their visual centers', () => {
  for (const model of ['tank','hx']) for (const device of devices(model)) for (const scale of [0.15,0.3,0.55,1,1.8]) {
    const box = hitBox(device, scale), [x,y,w,h] = device.box;
    assert.ok(box.width * scale >= 44 - 1e-8 && box.height * scale >= 44 - 1e-8);
    assert.equal(box.x + box.width / 2, x + w / 2);
    assert.ok(Math.abs(box.y + box.height / 2 - (y + h / 2)) < 1e-8);
  }
});
test('overlapping small-scale hit regions select the nearest device instead of SVG paint order', () => {
  const a = { node:'pump',rect:{ left:0,right:44,top:0,bottom:44 } };
  const b = { node:'valve',rect:{ left:38,right:82,top:0,bottom:44 } };
  assert.equal(nearestHit({ x:39,y:22 }, [b,a]), 'pump');
  assert.equal(nearestHit({ x:43,y:22 }, [a,b]), 'valve');
  assert.equal(nearestHit({ x:100,y:22 }, [a,b]), null);
});
