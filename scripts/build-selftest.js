'use strict';
const path = require('node:path');
const { compileTargets } = require('./native-build');
const root = path.resolve(__dirname, '..');
compileTargets([
  { name: 'selftest_hx', outFile: path.join(root, process.platform === 'win32' ? 'native-hx/build/selftest_hx.exe' : 'bin/selftest_hx'),
    sources: ['native-hx/selftest_hx.cpp', 'native-hx/hx_model.cpp', 'native/pid.cpp'].map(source => path.join(root, source)) },
  { name: 'selftest_tank', outFile: path.join(root, process.platform === 'win32' ? 'native/build/selftest_tank.exe' : 'bin/selftest_tank'),
    sources: ['native/selftest_tank.cpp', 'native/model.cpp', 'native/pid.cpp'].map(source => path.join(root, source)) },
]);
