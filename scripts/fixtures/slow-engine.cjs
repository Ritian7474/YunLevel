'use strict';
const readline = require('node:readline');
let serial = 0;
const state = () => JSON.stringify({ type: 'state', serial: serial++, sim_time: 0 }) + '\n';
setInterval(() => {}, 1000);
readline.createInterface({ input: process.stdin }).on('line', command => {
  if (command === 'CRASH') process.exit(7);
  if (command === 'HANG') return;
  if (command === 'QUIT') { process.stdout.write(state()); return; } // Reply without exiting: stop fallback must kill.
  if (command.startsWith('DELAY')) return setTimeout(() => process.stdout.write(state()), Number(command.split(' ')[1] || 100));
  process.stdout.write(state());
});
