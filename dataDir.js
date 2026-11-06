const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// 用户数据目录管理：
// - 默认目录 %APPDATA%/zheye
// - 支持自定义位置：指针文件 data-location.txt（纯文本路径，UTF-8 无 BOM 无换行）。
//   指针放在默认目录而不是数据目录里——无论数据搬到哪里，程序启动时永远能找到它；
//   NSIS 卸载器也要读它（已实测 FileRead 对含中文/反斜杠路径无损）
// - 切换采用事务式：①全部落盘 → ②复制到新目录 → ③字节级校验 → ④原子写指针
//   （提交点）→ ⑤内存切换 → ⑥清理旧目录。任何一步失败旧数据原样保留：
//   提交点之前崩溃 = 继续用旧目录；之后崩溃 = 新目录已生效，旧目录只是残留副本

const DATA_FILES = ['tasks.json', 'config.json', 'audit.json'];

function defaultDir() {
  return path.join(app.getPath('appData'), 'zheye');
}

function pointerFile() {
  return path.join(defaultDir(), 'data-location.txt');
}

function getCustomDir() {
  try {
    const s = fs.readFileSync(pointerFile(), 'utf8').trim();
    if (s && path.isAbsolute(s)) return s;
  } catch (_e) { /* 无指针 = 默认位置 */ }
  return null;
}

function currentDir() {
  return getCustomDir() || defaultDir();
}

function isCustom() {
  return !!getCustomDir();
}

// 已实例化的 Store 注册进来：切换前统一落盘、切换后统一从新位置重读
const stores = new Set();
function registerStore(s) {
  stores.add(s);
}

function flushAll() {
  for (const s of stores) s.save();
}

// 原子写指针：先写临时文件再改名，避免写一半留下半截指针
function writePointer(dir) {
  const p = pointerFile();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, dir, 'utf8');
  fs.renameSync(tmp, p);
}

// 真实可写性测试（Windows 上 W_OK 对目录不可靠，直接写探针文件）
function assertWritable(dir) {
  const probe = path.join(dir, '.zheye-write-test');
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
}

// 复制数据文件到目标目录并逐个字节级校验
function copyData(from, to) {
  fs.mkdirSync(to, { recursive: true });
  assertWritable(to);
  const copied = [];
  for (const f of DATA_FILES) {
    const src = path.join(from, f);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(to, f);
    fs.copyFileSync(src, dst);
    if (!fs.readFileSync(src).equals(fs.readFileSync(dst))) {
      throw new Error('复制校验失败：' + f);
    }
    copied.push(f);
  }
  return copied;
}

// 清理目录中的数据文件。指针文件若在本目录（=默认目录）则保留——程序/卸载器还要靠它找位置
function removeData(dir) {
  for (const f of DATA_FILES) {
    for (const n of [f, f + '.tmp']) {
      try { fs.unlinkSync(path.join(dir, n)); } catch (_e) { /* 不存在忽略 */ }
    }
  }
  try {
    if (path.resolve(dir) !== path.resolve(defaultDir()) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir); // 旧目录已空且非默认目录 → 顺手删掉空壳
    }
  } catch (_e) { /* 非空或被占用则保留 */ }
}

// a 是否是 b 的内部路径
function isInside(a, b) {
  const rel = path.relative(path.resolve(a), path.resolve(b));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 切换到新目录（事务式，见文件头注释）
function changeTo(newDirRaw) {
  const newDir = path.resolve(newDirRaw);
  const oldDir = path.resolve(currentDir());
  if (newDir === oldDir) throw new Error('新位置与当前位置相同');
  if (isInside(oldDir, newDir)) throw new Error('新位置不能在当前数据目录内部');
  if (isInside(newDir, oldDir)) throw new Error('当前数据目录在新位置内部，请选择其他文件夹');
  fs.mkdirSync(newDir, { recursive: true });
  flushAll();                              // ① 全部落盘
  const copied = copyData(oldDir, newDir); // ②③ 复制 + 校验
  writePointer(newDir);                    // ④ 原子提交（此后新目录生效）
  for (const s of stores) s.reload();      // ⑤ 内存切到新目录
  removeData(oldDir);                      // ⑥ 清理旧目录
  return copied;
}

// 恢复默认位置：提交点 = 删除指针（回到"无自定义"状态）
function resetToDefault() {
  const def = path.resolve(defaultDir());
  const oldDir = path.resolve(currentDir());
  if (oldDir === def) return [];
  flushAll();
  const copied = copyData(oldDir, def);
  try { fs.unlinkSync(pointerFile()); } catch (_e) { /* 指针本来就不存在 */ }
  for (const s of stores) s.reload();
  removeData(oldDir);
  return copied;
}

module.exports = {
  DATA_FILES, defaultDir, pointerFile, getCustomDir, currentDir, isCustom,
  registerStore, changeTo, resetToDefault,
};
