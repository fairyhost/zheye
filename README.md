# 折页 (ZheYe)

工作清单备忘 + 甘特图 + 桌面挂件，一个轻量的 Windows 桌面应用。

把待办清单、时间规划和一块贴边挂件装进同一扇小窗：清单随手记、甘特看全局，挂件贴边停靠不占地方。

## 功能特性

- **工作清单**
  - 弹窗快速添加（内容 / 描述 / 时间，默认今天 09:00 ~ 18:00），双击条目就地编辑
  - 四个标签页自动分区，任务按时间归位
  - 到时提醒（主进程定时扫描）
- **甘特图**
  - 时间全景视图，28 / 56 天两种跨度，◀▶ 翻页浏览
  - 条目就地编辑，与清单数据实时同步
- **桌面挂件**
  - 多皮肤（`skins/` 下每个皮肤一个 manifest，可自行扩展）
  - 贴边停靠，四种停靠方向（上/下/左/右），自动收起展开
  - 静态渲染，资源占用极低
- **数据管理**
  - 数据默认存于 `%APPDATA%/zheye`，支持事务式迁移到自定义目录（复制 → 字节级校验 → 原子提交，失败自动回退）
  - 首次启动询问是否开机自启

## 下载安装

前往 [Releases](../../releases) 页面下载：

| 文件 | 说明 |
|---|---|
| `ZheYe-Setup-x.x.x.exe` | NSIS 安装版，支持自选安装目录 |
| `ZheYe-Portable-x.x.x.exe` | 便携版，免安装单文件 |

## 开发

```bash
# 安装依赖（需要 Node.js 18+）
npm install

# 开发模式运行（带控制台日志与 DevTools）
npm start          # 或 npm run dev
```

### 打包

```bash
npm run dist       # 输出到项目内 release/<version>/
npm run dist:d     # 输出到 D:/build/折页/<version>/
```

产物包含 NSIS 安装包、便携版和未打包目录（`win-unpacked/`）。

## 技术栈

- [Electron](https://www.electronjs.org/) 33 + 原生 HTML / CSS / JavaScript（无前端框架）
- [electron-builder](https://www.electron.build/) 打包
- 数据层：JSON 文件 + 原子写入，无数据库依赖

## 目录结构

```
main.js            主进程：窗口管理、停靠/拖拽、提醒扫描、IPC
preload.js         预加载脚本：petAPI / memoAPI / ganttAPI / askAPI
dataDir.js         用户数据目录管理（默认位置 / 自定义迁移 / 原子指针）
store.js           JSON 存储层
memo.html/js/css   清单窗口
gantt.html/js/css  甘特图窗口
pet.html/js/css    桌面挂件窗口
ask.html/js/css    首启询问（开机自启）
skins/             挂件皮肤（manifest 配置）
scripts/           打包与开发辅助脚本
```

## License

[MIT](./LICENSE) © 2026 fairyhost
