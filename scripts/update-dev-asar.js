// 开发迭代热更新：从项目源码重建 win-unpacked 的 app.asar（不跑 electron-builder）
// 用法：node scripts/update-dev-asar.js
const asar = require('../node_modules/@electron/asar');
const fs = require('fs');
const path = require('path');

const project = path.join(__dirname, '..');
const dest = path.join(project, 'release', 'win-unpacked', 'resources', 'app.asar');

// 与 electron-builder files 等效的运行时文件清单（排除 node_modules/release/scripts/frames 等）
const INCLUDE = [
  'main.js', 'preload.js', 'store.js',
  'pet.js', 'pet.html', 'pet.css',
  'memo.js', 'memo.html', 'memo.css',
  'gantt.js', 'gantt.html', 'gantt.css',
  'ask.js', 'ask.html', 'ask.css',
  'package.json',
  'skins/note/manifest.json',
  'assets/note.png', 'assets/icon.ico',
];

(async () => {
  for (const rel of INCLUDE) {
    if (!fs.existsSync(path.join(project, rel))) {
      console.error('缺少文件: ' + rel);
      process.exit(1);
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
  await asar.createPackageFromFiles(project, dest, INCLUDE.map((rel) => path.join(project, rel)));
  const size = fs.statSync(dest).size;
  console.log('UPDATE_OK app.asar ' + size + ' bytes (' + INCLUDE.length + ' files)');
})().catch((e) => { console.error('UPDATE_FAIL ' + e.message); process.exit(1); });
