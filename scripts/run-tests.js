'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
for (const script of ['build-engine.js', 'build-selftest.js', 'check.js']) run(process.execPath, [path.join('scripts', script)]);
const tests = fs.readdirSync(path.join(root, 'scripts')).filter(file => file.endsWith('.test.js')).sort().map(file => path.join('scripts', file));
run(process.execPath, ['--test', ...tests]);
run(path.join(root, process.platform === 'win32' ? 'native-hx/build/selftest_hx.exe' : 'bin/selftest_hx'), []);
run(process.execPath, ['scripts/smoke-e2e.js']);
