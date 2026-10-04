'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function run(args) {
  console.log(`\n> node ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.signal) {
    console.error(`Controls check terminated by ${result.signal}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const file of [
  'public/app.js',
  'public/control-workspace.js',
  'public/parameter-slider.js',
  'public/parameter-feedback.js',
  'public/workspace-motion.js',
  'public/process-devices.js',
  'public/process-device-controls.js',
]) {
  run(['--check', file]);
}

run([
  '--test',
  'scripts/control-workspace.test.js',
  'scripts/parameter-slider.test.js',
  'scripts/critical-readouts.test.js',
  'scripts/parameter-feedback.test.js',
  'scripts/workspace-motion.test.js',
  'scripts/process-devices.test.js',
  'scripts/process-device-controls.test.js',
]);
