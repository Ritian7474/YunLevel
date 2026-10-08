'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';
function newest(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /^\d+\./.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] : null;
}
function msvc() {
  const programFiles = process.env['ProgramFiles(x86)'];
  if (!programFiles) return null;
  const query = spawnSync(path.join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe'),
    ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
    { encoding: 'utf8', windowsHide: true });
  const install = (query.stdout || '').trim();
  if (!install) return null;
  const toolsRoot = path.join(install, 'VC/Tools/MSVC');
  const vcVersion = newest(toolsRoot);
  const kits = path.join(programFiles, 'Windows Kits/10');
  const sdk = newest(path.join(kits, 'Include'));
  if (!vcVersion || !sdk) return null;
  const vc = path.join(toolsRoot, vcVersion);
  const bin = path.join(vc, 'bin/Hostx64/x64');
  const env = { ...process.env };
  env.Path = `${bin};${env.Path || env.PATH || ''}`;
  env.PATH = env.Path;
  env.INCLUDE = [path.join(vc, 'include'), ...['ucrt', 'shared', 'um'].map(part => path.join(kits, 'Include', sdk, part))].join(';');
  env.LIB = [path.join(vc, 'lib/x64'), ...['ucrt', 'um'].map(part => path.join(kits, 'Lib', sdk, part, 'x64'))].join(';');
  return { command: path.join(bin, 'cl.exe'), env, msvc: true };
}
function compiler() {
  const names = isWin ? ['g++', process.env.MINGW_BIN && path.join(process.env.MINGW_BIN, 'g++.exe')].filter(Boolean) : ['g++', 'c++'];
  for (const command of names) {
    const env = { ...process.env };
    if (path.isAbsolute(command)) env.Path = env.PATH = `${path.dirname(command)}${path.delimiter}${env.Path || env.PATH || ''}`;
    if (spawnSync(command, ['--version'], { env, windowsHide: true }).status === 0) return { command, env };
  }
  if (isWin) { const found = msvc(); if (found) return found; }
  throw new Error('需要支持 C++17 的 g++；Windows 也支持 Visual Studio C++ 工具和 Windows SDK。');
}
function compileTargets(targets) {
  const tool = compiler();
  console.log(`C++ compiler: ${tool.command}`);
  for (const target of targets) {
    for (const source of target.sources) if (!fs.existsSync(source)) throw new Error(`缺少源文件：${source}`);
    fs.mkdirSync(path.dirname(target.outFile), { recursive: true });
    let args;
    if (tool.msvc) {
      const objects = path.join(ROOT, '.tmp-build-objects', target.name);
      fs.mkdirSync(objects, { recursive: true });
      args = ['/nologo', '/std:c++17', '/EHsc', '/O2', '/MT', '/utf-8', '/W3', '/D_CRT_SECURE_NO_WARNINGS', `/Fo:${objects}${path.sep}`, `/Fe:${target.outFile}`, ...target.sources];
    } else {
      args = ['-O2', '-std=c++17', '-Wall', '-Wextra', ...(isWin ? ['-static'] : ['-static-libstdc++', '-static-libgcc']), '-o', target.outFile, ...target.sources];
    }
    const result = spawnSync(tool.command, args, { stdio: 'inherit', env: tool.env, windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
    console.log(`Built ${target.name}: ${target.outFile}`);
  }
}
module.exports = { compileTargets };
