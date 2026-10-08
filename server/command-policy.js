'use strict';
const STUDENT_COMMANDS = new Set(['STATE','START','PAUSE','RESET','SET_MODE','SET_PUMP','SET_VALVE',
  'SET_BIAS','SET_PID','SET_FUEL','SET_INLET_TEMP','SET_YAXIS','LOOP_ADD','LOOP_DEL','LOOP_CLEAR',
  'CASC_ADD','CASC_DEL','CASC_CLEAR','SCORE_START']);
const TEACHER_COMMANDS = new Set([...STUDENT_COMMANDS, 'SET_SP','SET_FLOW_SP','SET_PVX_SP','SET_INIT_TEMP',
  'SCENARIO','TEMPLATE_A','TEMPLATE_B','PRESET','HIGH_SCORE','SCORE_CFG','SCORE_MODE','SCORE_TANK',
  'SCORE_OBJECT','SCORE_END','TICK','SAVE']);
const INTERNAL_COMMANDS = new Set(['QUIT','DEACTIVATE','SCORE_FINISH']);
function commandPermission(role, command) {
  if (STUDENT_COMMANDS.has(command)) return true;
  if (TEACHER_COMMANDS.has(command)) return role === 'teacher';
  if (INTERNAL_COMMANDS.has(command)) return false;
  return null;
}
module.exports = { commandPermission };
