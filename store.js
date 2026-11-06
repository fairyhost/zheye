const fs = require('fs');
const path = require('path');
const { currentDir } = require('./dataDir');

// 简单 JSON 存储：文件路径按当前数据目录动态解析（支持运行中切换数据目录），
// 读入内存、写临时文件后原子替换，防止写一半断电损坏数据
class Store {
  constructor(name, defaults) {
    this.name = name;
    this.data = JSON.parse(JSON.stringify(defaults));
    this.existed = fs.existsSync(this.file);
    if (this.existed) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...this.data, ...raw };
      } catch (_e) {
        // 文件损坏时按默认值重新开始，下次保存会覆盖
      }
    }
  }

  get file() {
    return path.join(currentDir(), this.name);
  }

  // 切换数据目录后从新位置重读。内容刚被完整校验复制过，正常必能读成功；
  // 万一失败保留内存数据（与刚落盘的内容一致），保证功能不中断
  reload() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...raw };
      this.existed = true;
    } catch (e) {
      console.error('[store] 重读失败，保留内存数据', this.file, e);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] 保存失败', this.file, e);
    }
  }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = { Store, uid };
