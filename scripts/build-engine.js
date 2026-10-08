#!/usr/bin/env node
// 编译 C++ 仿真内核。
//   tank : native/engine.cpp + model.cpp + pid.cpp + score.cpp -> native/build/YunEngine.exe
//   hx   : native-hx/engine-hx.cpp + hx_model.cpp + hx_score.cpp + native/pid.cpp
//          -> native-hx/build/HxEngine.exe
// 两个内核共用同一份 native/pid.cpp，保证 DCS 口径 Ki = 1/Ti 只有一个实现。
// hx 目标缺失源文件时只跳过，不影响液位内核的构建（零回归）。
const { compileTargets } = require('./native-build');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

const targets = [
  {
    name: 'tank',
    outFile: isWin
      ? path.join(root, 'native', 'build', 'YunEngine.exe')
      : path.join(root, 'bin', 'YunEngine'),
    sources: ['engine.cpp', 'model.cpp', 'pid.cpp', 'score.cpp']
      .map((name) => path.join(root, 'native', name)),
    required: true,
  },
  {
    name: 'hx',
    outFile: isWin
      ? path.join(root, 'native-hx', 'build', 'HxEngine.exe')
      : path.join(root, 'bin', 'HxEngine'),
    sources: [
      path.join(root, 'native-hx', 'engine-hx.cpp'),
      path.join(root, 'native-hx', 'hx_model.cpp'),
      path.join(root, 'native-hx', 'hx_score.cpp'),
      path.join(root, 'native', 'pid.cpp'),
    ],
    required: true,
  },
];

compileTargets(targets);
