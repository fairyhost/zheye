const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store, uid } = require('./store');

// 启动追踪（排查打包环境问题；boot-trace.txt 每阶段追加一行）
function trace(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath('appData'), 'zheye', 'boot-trace.txt'),
      new Date().toISOString() + ' ' + msg + '\n');
  } catch (_e) { /* 尽力而为 */ }
}
trace('main.js module loaded, isPackaged=' + app.isPackaged);

// 数据目录固定为 %APPDATA%/zheye，开发与打包后保持一致。
// 首次运行时从旧目录 %APPDATA%/desk-pet 自动迁移数据文件（tasks/config），
// 旧目录原样保留不删——配合导出/导入功能形成双保险
function migrateDataDir() {
  const newPath = path.join(app.getPath('appData'), 'zheye');
  const oldPath = path.join(app.getPath('appData'), 'desk-pet');
  if (fs.existsSync(newPath) || !fs.existsSync(oldPath)) return;
  try {
    fs.mkdirSync(newPath, { recursive: true });
    for (const f of fs.readdirSync(oldPath)) {
      if (f === 'tasks.json' || f === 'config.json') {
        fs.copyFileSync(path.join(oldPath, f), path.join(newPath, f));
      }
    }
    trace('data migrated: ' + oldPath + ' -> ' + newPath);
  } catch (e) {
    // 迁移失败不阻塞启动：新目录会用默认值开始，用户可用导入功能手动恢复
    console.error('[migrate] 数据目录迁移失败', e);
  }
}
migrateDataDir();
app.setPath('userData', path.join(app.getPath('appData'), 'zheye'));
trace('userData set: ' + app.getPath('userData'));

const SIZE_LABELS = { tiny: '极小', small: '小', medium: '中', large: '大' };
const SNAP_PX = 8;       // 距屏幕边多少像素内才算"顶到边"（吸附需要刻意往墙上顶）
const DOCK_DWELL_MS = 500; // 顶住边缘多久才吸附（防止路过/停放误触发）

const tasksStore = new Store('tasks.json', { items: [] });
const configStore = new Store('config.json', {
  petHeight: 200,
  petPos: null,
  memoSize: { width: 360, height: 520 },
  ganttSize: { width: 1000, height: 640 },
  ganttPos: null,
  expanded: false,
  memoPinned: true,    // 清单窗置顶（floating 层级：压普通窗口、低于桌宠 screen-saver）
  ganttPinned: true,   // 甘特窗置顶，同上
  dock: null,          // {side, along, displayId}；null=未停靠
  dockPeekMode: 'hover', // 停靠后行为：hover=悬停弹出（默认）/ pinned=固定收起不弹出
  // （提醒时机不再可配：日期类任务当天 09:30，带时间任务提前 5 分钟）
  firstRunDone: false,
});

// 数据目录管理：注册后可运行中切换存储位置（事务式，见 dataDir.js 头注释）
const dataDir = require('./dataDir');
dataDir.registerStore(tasksStore);
dataDir.registerStore(configStore);

// 皮肤包：manifest 驱动尺寸/动画/行为参数
const SKIN_DIR = path.join(__dirname, 'skins', 'note');
const manifest = JSON.parse(fs.readFileSync(path.join(SKIN_DIR, 'manifest.json'), 'utf8'));
// 静态形象模式：桌宠回到最早期的静态贴图，自主行为引擎（溜达/情绪/睡觉）暂不启用（清单功能优先）
// 旧尺寸迁移到当前皮肤档位（向上取档）
if (!Object.values(manifest.sizes).includes(configStore.data.petHeight)) {
  const sorted = Object.values(manifest.sizes).sort((a, b) => a - b);
  configStore.data.petHeight = sorted.find((h) => h >= configStore.data.petHeight) || sorted[sorted.length - 1];
  configStore.save();
}

let petWin = null;
let memoWin = null;
let askWin = null;
let ganttWin = null;
let dragState = null;
let dragPoller = null;
let quitting = false;

// 调试支持：--devtools 参数或 DESK_PET_DEVTOOLS 环境变量启动时自动开 DevTools；任意窗口按 F12 随时开关
const DEVTOOLS = process.argv.includes('--devtools') || !!process.env.DESK_PET_DEVTOOLS;

// 热更新由 npm run dev（electronmon）提供：
//   渲染层文件（html/css/js）改动 → hook 对所有窗口 reloadIgnoringCache（进程不重启）
//   主进程文件（main.js/store.js）改动 → 整进程自动重启

function hookDevTools(win) {
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  if (DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}

// 开机启动写 HKCU Run；开发态补上应用目录参数，否则会拉起 electron 默认示例
const loginArgs = app.isPackaged ? [] : [__dirname];

function getAutoStart() {
  return app.getLoginItemSettings({ args: loginArgs }).openAtLogin;
}

function setAutoStart(on) {
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: loginArgs });
}

// ---------- 时间工具（主进程侧，供提醒扫描用） ----------
function pad(n) { return String(n).padStart(2, '0'); }

// '' → NaN/Infinity；"YYYY-MM-DD" 按当天 23:59:59；带 T 时刻按本地时间
function tsOf(str) {
  if (!str) return Infinity;
  return str.length === 10
    ? new Date(str + 'T23:59:59.999').getTime()
    : new Date(str).getTime();
}

function hasTimeStr(str) { return !!str && str.length > 10; }

// ---------- 首次运行：预置示例任务 ----------
if (!tasksStore.existed) {
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
  const iso = (d, hh, mm) => {
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hh)}:${p(mm)}`;
  };
  const mk = (text, start, deadline) => ({
    id: uid(), text, start, deadline,
    done: false, createdAt: Date.now(), finishedAt: null, remindedAt: null,
  });
  tasksStore.data.items = [
    mk('示例：我在甘特图里是一根完整横条（开始→完成）', iso(day(-1), 9, 0), iso(day(1), 18, 0)),
    mk('示例：点左侧 ✓ 完成我，看看划线沉底', '', iso(day(0), 23, 59)),
    mk('示例：我是逾期标红的样子，不需要就删掉', '', iso(day(-1), 18, 0)),
    mk('示例：留空日期就是「待安排」，归长远', '', ''),
  ];
  tasksStore.save();
}

// ---------- 宠物窗口 ----------
function createPet() {
  const h = configStore.data.petHeight || 160;
  petWin = new BrowserWindow({
    width: h,
    height: h,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  petWin.setAlwaysOnTop(true, 'screen-saver');
  hookDevTools(petWin);
  petWin.loadFile('pet.html');
  petWin.webContents.on('did-finish-load', () => {
    sendDockState();
  });
  petWin.on('closed', () => { petWin = null; });
}

// 上次位置超出当前所有屏幕时返回 null，调用方走兜底
function validPos(pos, w, h) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return null;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return pos.x < a.x + a.width && pos.x + w > a.x && pos.y < a.y + a.height && pos.y + h > a.y;
  }) ? pos : null;
}

// ---------- 停靠几何 ----------
function findDisplayForDock(dock) {
  // 吸附时记住的显示器优先，防止两屏交界处（主屏右缘=副屏左缘）串屏
  if (dock.displayId) {
    const hit = screen.getAllDisplays().find((d) => d.id === dock.displayId);
    if (hit) return hit;
  }
  const horizontal = dock.side === 'top' || dock.side === 'bottom';
  const hit = screen.getAllDisplays().find((d) => {
    const a = d.workArea;
    return horizontal
      ? dock.along >= a.x && dock.along <= a.x + a.width
      : dock.along >= a.y && dock.along <= a.y + a.height;
  });
  return hit || screen.getPrimaryDisplay();
}

function dockGeom(dock, petH) {
  // 收起态（加速球式·仅右停靠）：窗口只占露出条宽度（reveal），贴图以全身尺寸渲染、
  // 右侧溢出被窗口自身裁掉（pet.css body.docked 左上角锚定 + overflow hidden），
  // 露出的就是贴图左半身（从左边缘到脚）。
  // 窗口全程不出屏——不依赖"推出屏幕外靠屏幕边裁切"，规避越界窗口在 Windows 上的
  // setBounds 成功但视觉不更新、DPI/多屏边缘怪癖等问题
  const revealW = Math.max(Math.round(petH * (manifest.dock.reveal || 0.35)), 24);
  const a = findDisplayForDock(dock).workArea;
  const clampAlong = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  // along 脏数据防御：null/NaN 会让 y 计算成 NaN，窗口被系统扔到屏幕外
  const along = Number.isFinite(dock.along) ? dock.along : a.y + a.height / 2;
  return {
    x: a.x + a.width - revealW,
    y: clampAlong(along - petH / 2, a.y, a.y + a.height - petH),
    width: revealW,
    height: petH,
  };
}

// 显示器 d 的右缘是否是真实屏幕外缘（右侧没有相邻显示器）。
// 两屏交界（如副屏在主屏左侧时的副屏右缘）不能吸附——"收进边缘"会把身子推进隔壁屏幕。
function isOuterRightEdge(d) {
  return !screen.getAllDisplays().some((o) =>
    o.id !== d.id && o.bounds.x >= d.bounds.x + d.bounds.width - 1
  );
}

// 悬停弹出态：全身尺寸贴着停靠边，沿边位置不变
function dockExpandedGeom(dock, petH) {
  const a = findDisplayForDock(dock).workArea;
  const clampAlong = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const along = Number.isFinite(dock.along) ? dock.along : a.y + a.height / 2;
  if (dock.side === 'top') {
    return { x: clampAlong(along - petH / 2, a.x, a.x + a.width - petH), y: a.y, width: petH, height: petH };
  }
  if (dock.side === 'bottom') {
    return { x: clampAlong(along - petH / 2, a.x, a.x + a.width - petH), y: a.y + a.height - petH, width: petH, height: petH };
  }
  if (dock.side === 'left') {
    return { x: a.x, y: clampAlong(along - petH / 2, a.y, a.y + a.height - petH), width: petH, height: petH };
  }
  return { x: a.x + a.width - petH, y: clampAlong(along - petH / 2, a.y, a.y + a.height - petH), width: petH, height: petH };
}

function applyDock(win, dock) {
  const petH = configStore.data.petHeight || 160;
  const g = dockGeom(dock, petH);
  peeked = false; // 任何吸附/尺寸重置都回到收起态
  win.setBounds(g);
  sendDockState();
}

function sendDockState() {
  if (petWin && !petWin.isDestroyed()) {
    const dock = dragState ? dragState.dock : configStore.data.dock;
    const peeking = !!dock && peeked && (!dragState || dragState.peekDrag);
    petWin.webContents.send('pet:dock-state', { docked: !!dock, side: dock ? dock.side : null, peeked: peeking, pet: configStore.data.petHeight || 160, peekMode: dockPeekMode() });
  }
}

// 停靠/弹出交互诊断日志（boot-trace.txt 追加，排查"弹不出来/点击无效"类问题用）
function tracePeek(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath('appData'), 'zheye', 'boot-trace.txt'),
      new Date().toISOString() + ' [dock] ' + msg + '\n');
  } catch (_e) { /* 尽力而为 */ }
}

// ---------- 停靠悬停弹出（加速球式）：鼠标移入露出条 → 全身弹出；移开 → 收回 ----------
let peeked = false;
let peekCooldownUntil = 0;

function dockPeekMode() {
  return configStore.data.dockPeekMode === 'pinned' ? 'pinned' : 'hover';
}

function setDockPeekMode(mode) {
  configStore.data.dockPeekMode = mode === 'pinned' ? 'pinned' : 'hover';
  configStore.save();
  tracePeek(`dockPeekMode → ${mode}`);
  // 切到固定收起时若正处于弹出态，立即收回
  if (configStore.data.dockPeekMode === 'pinned' && peeked) setPeek(false);
  sendDockState();
}

function setPeek(on) {
  const dock = configStore.data.dock;
  if (!petWin || petWin.isDestroyed() || !dock || dragState) {
    tracePeek(`setPeek(${on}) skip: ${!dock ? 'no-dock' : dragState ? 'dragging' : 'no-win'}`);
    return;
  }
  if (on && dockPeekMode() === 'pinned') {
    tracePeek('setPeek(true) skip: pinned mode'); // 固定收起模式：悬停/点击不弹出
    return;
  }
  if (on === peeked) return;
  // 冷却只保护"收回"：弹出是边沿触发（mouseenter/看门狗 entered 只在进入瞬间发一次），
  // 若被冷却挡掉事件就永久丢失——表现为悬停/点击都弹不出来。收回是电平态，被挡可重试。
  if (!on && Date.now() < peekCooldownUntil) return;
  peeked = !!on;
  if (on) peekCooldownUntil = Date.now() + 250; // 弹出后 250ms 内不收回，防尺寸切换瞬间误判抖动
  const petH = configStore.data.petHeight || 160;
  petWin.setBounds(peeked ? dockExpandedGeom(dock, petH) : dockGeom(dock, petH));
  tracePeek(`setPeek(${on}) ok, bounds=${JSON.stringify(petWin.getBounds())}`);
  sendDockState();
}

// 弹出态看门狗：原生右键菜单打开期间渲染层收不到 mouseleave，光标离开后窗口会卡在弹出态。
// 主进程每 120ms 检查光标是否还在窗口内，不在就强制收回——除非主动拖出来，否则始终贴边停靠。
let peekWatchdog = null;
function ensurePeekWatchdog() {
  if (peekWatchdog) return;
  // prevInside 每个 tick 都更新（与停靠/拖拽状态无关），否则拖拽期间状态过期，
  // 停靠完成后会误判一次"进入"导致刚收起就弹出
  let prevInside = null;
  peekWatchdog = setInterval(() => {
    if (!petWin || petWin.isDestroyed()) return;
    const b = petWin.getBounds();
    const c = screen.getCursorScreenPoint();
    const inside = c.x >= b.x - 2 && c.x < b.x + b.width + 2
      && c.y >= b.y - 2 && c.y < b.y + b.height + 2;
    const entered = prevInside === false && inside;   // 离开→进入
    const left = prevInside === true && !inside;      // 进入→离开
    prevInside = inside;
    if (!configStore.data.dock || dragState) return;
    if (!peeked && entered && dockPeekMode() === 'hover') {
      setPeek(true);  // 悬停弹出：主进程检测，不依赖渲染层 mouseenter（吸附时光标已在窗口内、原生菜单抢事件等场景都会丢）
    } else if (peeked && left) {
      setPeek(false); // 移开收回（冷却期内可能被挡，下个 tick 自动重试）
    }
  }, 120);
}

function placePetInitially() {
  const petH = configStore.data.petHeight || 160;
  // 有停靠记忆且是右停靠 → 直接恢复收起姿态（只支持右停靠）。
  // along 脏数据（NaN/null）或停靠边不是真实外缘（如两屏交界）→ 清除停靠走自由位置兜底
  const dock = configStore.data.dock;
  if (dock && dock.side === 'right') {
    const d = findDisplayForDock(dock);
    if (Number.isFinite(dock.along) && isOuterRightEdge(d)) {
      petWin.setBounds(dockGeom(dock, petH));
      return;
    }
    configStore.data.dock = null;
    configStore.save();
  }
  configStore.data.dock = null;
  const b = petWin.getBounds();
  const pos = validPos(configStore.data.petPos, b.width, b.height);
  if (pos) {
    petWin.setPosition(pos.x, pos.y);
  } else {
    const wa = screen.getPrimaryDisplay().workArea;
    petWin.setPosition(wa.x + wa.width - b.width - 32, wa.y + wa.height - b.height - 32);
  }
}

// ---------- 清单窗口 ----------
function createMemo() {
  const { width, height } = configStore.data.memoSize;
  memoWin = new BrowserWindow({
    width,
    height,
    backgroundColor: '#f4f7f8', // 与 memo.css --bg 一致，显示瞬间不闪白底
    frame: false,
    show: false,
    resizable: true,
    fullscreenable: false,
    maximizable: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  // 置顶用 floating 层级：高于普通窗口、低于桌宠的 screen-saver（层级序 floating < screen-saver）
  if (configStore.data.memoPinned !== false) memoWin.setAlwaysOnTop(true, 'floating');
  hookDevTools(memoWin);
  memoWin.loadFile('memo.html');
  let saveTimer = null;
  memoWin.on('resize', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!memoWin || memoWin.isDestroyed()) return;
      configStore.data.memoSize = memoWin.getBounds();
      configStore.save();
    }, 400);
  });
  memoWin.on('close', (e) => {
    // 点 ✕ 只是收起，真正退出走菜单「退出」
    if (!quitting) {
      e.preventDefault();
      hideMemo();
    }
  });
  memoWin.on('closed', () => { memoWin = null; });
}

function hideMemo() {
  if (memoWin && memoWin.isVisible()) memoWin.hide();
  configStore.data.expanded = false;
  configStore.save();
}

// 清单窗目标位置：贴着桌宠旁边（右侧放不下翻到左侧，夹在显示器工作区内）。
// 不依赖窗口可见——setPosition 对隐藏窗口同样生效，供"先定位后显示"用
function memoTargetPos() {
  if (!petWin || petWin.isDestroyed()) return null;
  const pb = petWin.getBounds();
  const m = memoWin && !memoWin.isDestroyed()
    ? memoWin.getBounds()
    : { width: configStore.data.memoSize.width, height: configStore.data.memoSize.height };
  const wa = screen.getDisplayMatching(pb).workArea;
  let x = pb.x + pb.width + 14;
  if (x + m.width > wa.x + wa.width) x = pb.x - m.width - 14;
  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - m.width);
  const y = Math.min(Math.max(pb.y, wa.y), wa.y + wa.height - m.height);
  return { x: Math.round(x), y: Math.round(y) };
}

function placeMemoNearPet() {
  if (!memoWin || memoWin.isDestroyed() || !memoWin.isVisible()) return;
  const p = memoTargetPos();
  if (p) memoWin.setPosition(p.x, p.y);
}

function openMemo() {
  if (!memoWin) {
    createMemo();
    // 关键：先在隐藏状态定位到桌宠当前位置旁，再显示。
    // 旧顺序是先 show（出现在上次旧位置）再移动过去，拖动桌宠后点击会看到明显跳位
    const p = memoTargetPos();
    if (p) memoWin.setPosition(p.x, p.y);
    memoWin.once('ready-to-show', () => memoWin.show());
  } else {
    const p = memoTargetPos();
    if (p) memoWin.setPosition(p.x, p.y); // 先定位后显示，消除可见位移
    memoWin.show();
    memoWin.focus();
  }
  configStore.data.expanded = true;
  configStore.save();
}

function toggleMemo() {
  if (memoWin && memoWin.isVisible()) hideMemo();
  else openMemo();
}

// ---------- 数据导出 / 导入 ----------
// 导出：任务+配置打包成一个带版本号的 JSON 文件，存到用户选的位置（换机/备份兜底）
// 导入：反向恢复，覆盖前弹窗确认；旧版备份文件（app: 'desk-pet'）也兼容

const DATA_APP_ID = 'zheye';

async function exportData() {
  try {
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const r = await dialog.showSaveDialog({
      title: '导出数据',
      defaultPath: 'zheye-backup-' + stamp + '.json',
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return;
    const payload = {
      app: DATA_APP_ID,
      version: 1,
      exportedAt: new Date().toISOString(),
      tasks: tasksStore.data,
      config: configStore.data,
    };
    fs.writeFileSync(r.filePath, JSON.stringify(payload, null, 2), 'utf8');
    notifyDone('数据已导出', '✅ 已导出到 ' + r.filePath);
  } catch (e) {
    console.error('[export] 导出失败', e);
    dialog.showErrorBox('导出失败', String(e && e.message || e));
  }
}

async function importData() {
  try {
    const r = await dialog.showOpenDialog({
      title: '导入数据',
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return;
    const file = r.filePaths[0];
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      dialog.showErrorBox('导入失败', '文件不是有效的 JSON：\n' + String(e && e.message || e));
      return;
    }
    // 校验：tasks 必须含 items 数组；config 可选。兼容旧版备份（app 字段为 desk-pet 或 zheye）
    const okTasks = payload && payload.tasks && Array.isArray(payload.tasks.items);
    const okConfig = !payload.config || (typeof payload.config === 'object' && payload.config !== null);
    if (!okTasks || !okConfig) {
      dialog.showErrorBox('导入失败', '备份文件格式不对：缺少 tasks.items 或 config 段。');
      return;
    }
    const warn = '导入将覆盖当前全部任务和配置，确定继续？\n\n' +
      '备份时间：' + (payload.exportedAt || '未知') + '\n' +
      '任务数：' + payload.tasks.items.length;
    const c = await dialog.showMessageBox({
      type: 'warning',
      title: '确认导入',
      message: warn,
      buttons: ['导入（覆盖）', '取消'],
      defaultId: 0,
      cancelId: 1,
    });
    if (c.response !== 0) return;
    // 合并式覆盖：先保留现有数据兜底字段，再整体盖掉；未知字段不丢
    tasksStore.data = { ...tasksStore.data, ...payload.tasks };
    if (payload.config) configStore.data = { ...configStore.data, ...payload.config };
    tasksStore.save();
    configStore.save();
    broadcastTasks(); // 清单/甘特立即刷新
    notifyDone('数据已导入', '✅ 已从备份恢复 ' + payload.tasks.items.length + ' 条任务');
  } catch (e) {
    console.error('[import] 导入失败', e);
    dialog.showErrorBox('导入失败', String(e && e.message || e));
  }
}

// ---------- 数据存储位置（查看/更改/恢复默认） ----------
// 菜单项太长会被系统截断，超长时掐中间保住盘符和末级目录名
function shortPath(p) {
  return p.length > 46 ? p.slice(0, 22) + '…' + p.slice(-22) : p;
}

async function changeDataLocation() {
  try {
    const r = await dialog.showOpenDialog({
      title: '选择数据存储位置',
      message: '选择用于存放任务与配置的文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return;
    const copied = dataDir.changeTo(r.filePaths[0]);
    notifyDone('数据位置已更改', '✅ 已迁移 ' + copied.length + ' 个文件到 ' + r.filePaths[0]);
  } catch (e) {
    // 事务式切换：任何失败数据都还在原位置
    dialog.showErrorBox('更改失败', '数据仍在原位置，未受影响。\n\n' + String((e && e.message) || e));
  }
}

function resetDataLocation() {
  try {
    dataDir.resetToDefault();
    notifyDone('已恢复默认数据位置', '✅ 数据已迁回 ' + dataDir.defaultDir());
  } catch (e) {
    dialog.showErrorBox('恢复失败', '数据仍在原位置，未受影响。\n\n' + String((e && e.message) || e));
  }
}

// 导入/导出结果反馈：系统通知 + 桌宠气泡，导入后再把清单窗打开让用户确认
function notifyDone(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
  } catch (_e) { /* 尽力而为 */ }
  petWin?.webContents.send('pet:bubble', { text: body.slice(0, 24) });
  openMemo();
}

// ---------- 系统托盘 ----------
let tray = null;

function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  const img = nativeImage.createFromPath(iconPath);
  tray = new Tray(img.isEmpty() ? path.join(__dirname, 'assets', 'note.png') : iconPath);
  tray.setToolTip('折页');
  // 不用 setContextMenu：设置后 Windows 左键也弹菜单且 click 事件失效；
  // 改为单击切清单、右键手动弹菜单（与主流应用一致）
  tray.on('click', () => toggleMemo());
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: '任务清单', click: () => toggleMemo() },
      { label: '甘特图', click: () => openGantt() },
      // 兜底恢复入口：宠物窗口无论什么原因不可见（如坐标异常），都能从托盘解除停靠找回
      { label: '解除停靠', visible: !!configStore.data.dock, click: () => undockDock() },
      { type: 'separator' },
      { label: '导出数据', click: () => exportData() },
      { label: '导入数据', click: () => importData() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
  });
}

// ---------- 右键菜单 ----------
function petMenu() {
  const cur = configStore.data.petHeight;
  return Menu.buildFromTemplate([
    { label: '开机启动', type: 'checkbox', checked: getAutoStart(), click: (item) => setAutoStart(item.checked) },
    { label: '解除停靠', visible: !!configStore.data.dock, click: () => undockDock() },
    {
      label: '停靠弹出',
      submenu: [
        { label: '悬停弹出', type: 'radio', checked: dockPeekMode() === 'hover', click: () => setDockPeekMode('hover') },
        { label: '固定收起', type: 'radio', checked: dockPeekMode() === 'pinned', click: () => setDockPeekMode('pinned') },
      ],
    },
    {
      label: '尺寸',
      submenu: Object.entries(manifest.sizes).map(([key, h2]) => ({
        label: `${SIZE_LABELS[key] || key}（${h2}px）`,
        type: 'radio',
        checked: cur === h2,
        click: () => setPetHeight(h2),
      })),
    },
    { label: '甘特图', click: () => openGantt() },
    {
      label: '数据备份',
      submenu: [
        { label: '存储位置：' + shortPath(dataDir.currentDir()), enabled: false },
        { label: '更改存储位置...', click: () => changeDataLocation() },
        { label: '恢复默认位置', visible: dataDir.isCustom(), click: () => resetDataLocation() },
        { type: 'separator' },
        { label: '导出数据', click: () => exportData() },
        { label: '导入数据', click: () => importData() },
      ],
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}

function setPetHeight(h) {
  configStore.data.petHeight = h;
  configStore.save();
  if (!petWin || petWin.isDestroyed()) return;
  if (dragState?.dock) {
    applyDock(petWin, dragState.dock);
    configStore.data.dock = { ...dragState.dock };
    configStore.save();
    return;
  }
  if (configStore.data.dock) {
    applyDock(petWin, configStore.data.dock);
    return;
  }
  const b = petWin.getBounds();
  petWin.setBounds({
    x: Math.round(b.x + (b.width - h) / 2),
    y: Math.round(b.y + (b.height - h)), // 底边不动，像站在原地缩放
    width: h,
    height: h,
  });
  const nb = petWin.getBounds();
  configStore.data.petPos = { x: nb.x, y: nb.y };
  configStore.save();
  if (memoWin && memoWin.isVisible()) placeMemoNearPet();
}

// ---------- 拖拽（主进程 16ms 轮询光标——光标跑出窗口也跟手；停靠需顶边停留 500ms） ----------
function onDragTick() {
  if (!dragState || !petWin || petWin.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();

  // ---- 停靠中 ----
  if (dragState.dock) {
    const dock = dragState.dock;
    const a = findDisplayForDock(dock).workArea;
    // 拖离判定：光标离停靠边的距离相对拖拽起点的增量（抓在身子哪个位置都不影响）
    const cd =
      dock.side === 'top' ? c.y - a.y
      : dock.side === 'bottom' ? a.y + a.height - c.y
      : dock.side === 'left' ? c.x - a.x
      : a.x + a.width - c.x;
    if (dragState.dockStartDist == null) dragState.dockStartDist = cd;
    if (cd - dragState.dockStartDist > SNAP_PX * 3) {
      // 向外拖 → 解除停靠；弹出态抓取的直接跟手，收起态抓取的以光标为中心恢复全身
      const wasPeek = !!dragState.peekDrag;
      dragState.dock = null;
      peeked = false;
      configStore.data.dock = null;
      configStore.save();
      if (!wasPeek) {
        const petH = configStore.data.petHeight || 160;
        petWin.setBounds({
          x: c.x - Math.round(petH / 2),
          y: c.y - Math.round(petH * 0.25),
          width: petH,
          height: petH,
        });
        const b2 = petWin.getBounds();
        dragState.offX = c.x - b2.x;
        dragState.offY = c.y - b2.y;
      }
      sendDockState();
    } else {
      // 沿边缘滑动更新位置（弹出态拖拽保持全身尺寸跟手，不收回）。
      // 1) 位移 <3px 视为纯点击，不动窗口——否则点击瞬间 along 被设成光标 y，
      //    窗口竖直跳到以光标为中心（点下半部表现为向下窜）；
      // 2) 实际拖动时保留抓取点相对偏移（startAlong + 增量），抓哪儿哪儿跟手。
      const moved = Math.hypot(c.x - dragState.startX, c.y - dragState.startY);
      if (moved > 3) {
        // startAlong 兜底：自由拖拽中途吸附（正常吸附手势）时，drag-start 阶段 dock
        // 还不存在、startAlong 未赋值，直接相加会得到 NaN 入库
        if (!Number.isFinite(dragState.startAlong)) dragState.startAlong = dock.along;
        dock.along = dragState.startAlong
          + ((dock.side === 'top' || dock.side === 'bottom') ? c.x - dragState.startX : c.y - dragState.startY);
        if (dragState.peekDrag) {
          peekCooldownUntil = Date.now() + 250;
          petWin.setBounds(dockExpandedGeom(dock, configStore.data.petHeight || 160));
        } else {
          applyDock(petWin, dock);
        }
      }
      return;
    }
  }

  // ---- 未停靠自由移动 ----
  const x = c.x - dragState.offX;
  const y = c.y - dragState.offY;
  petWin.setPosition(x, y);

  // 顶到边且停留 DOCK_DWELL_MS 才吸附（跨屏路过/短暂停放都不触发）
  // 按桌宠窗口边缘判定（光标抓在身子中间时离边还有几十像素，按光标判永远吸不上）
  // 只支持右停靠（收进右缘、露出左半身）；其他边缘不吸附
  const b = petWin.getBounds();
  const dp = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const a = dp.workArea;
  const dRight = a.x + a.width - (b.x + b.width);
  // isOuterRightEdge：两屏交界不吸附，否则收进"边缘"会把身子推进隔壁屏幕
  if (dRight <= SNAP_PX && isOuterRightEdge(dp)) {
    if (!dragState.pendingSince) dragState.pendingSince = Date.now();
    if (Date.now() - dragState.pendingSince >= DOCK_DWELL_MS) {
      // 锁定当前显示器，沿边滑动时不串屏
      dragState.dock = { side: 'right', along: c.y, displayId: dp.id };
      dragState.startAlong = c.y; // 吸附基准：此后沿边滑动以吸附点为原点
      applyDock(petWin, dragState.dock);
      return;
    }
  } else {
    dragState.pendingSince = null;
  }

  if (memoWin && memoWin.isVisible()) placeMemoNearPet();
}

function startDragPoll() {
  stopDragPoll();
  dragPoller = setInterval(onDragTick, 16);
}

function stopDragPoll() {
  if (dragPoller) {
    clearInterval(dragPoller);
    dragPoller = null;
  }
}

function undockDock() {
  configStore.data.dock = null;
  peeked = false;
  if (dragState) dragState.dock = null;
  const petH = configStore.data.petHeight || 160;
  let pos = validPos(configStore.data.petPos, petH, petH);
  if (!pos) {
    const wa = screen.getPrimaryDisplay().workArea;
    pos = { x: wa.x + Math.round((wa.width - petH) / 2), y: wa.y + Math.round((wa.height - petH) / 2) };
  }
  if (petWin && !petWin.isDestroyed()) {
    petWin.setBounds({ x: pos.x, y: pos.y, width: petH, height: petH });
  }
  configStore.data.petPos = { x: pos.x, y: pos.y };
  configStore.save();
  sendDockState();
}

ipcMain.on('pet:drag-start', () => {
  tracePeek('drag-start');
  if (!petWin || petWin.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  const b = petWin.getBounds();
  dragState = {
    offX: c.x - b.x,
    offY: c.y - b.y,
    startX: c.x,
    startY: c.y,
    dock: configStore.data.dock ? { ...configStore.data.dock } : null,
    peekDrag: peeked && !!configStore.data.dock, // 弹出态按下：拖拽沿边滑动时保持全身
    pendingSince: null,
    dockStartDist: null,
  };
  if (dragState.dock) {
    if (Number.isFinite(dragState.dock.along)) dragState.startAlong = dragState.dock.along;
    else dragState.dock = null; // along 脏数据按未停靠处理，松手后可重新吸附
  }
  startDragPoll();
  // 用户接触：唤醒 + 打断自主行为（挣扎动画由渲染进程本地切，这里不发 idle 覆盖）
});

ipcMain.on('pet:drag-end', () => {
  // 防双发：mouseup 和 blur 都会触发 endDrag，第二次进来时 dragState 已清空。
  // 若不拦截，会误走"自由拖拽收尾"分支把 configStore.data.dock 清掉，
  // 停靠状态被悄悄抹掉后 setPeek 的 !dock 守卫让收放永久失效（卡在弹出态）。
  if (!dragState) return;
  tracePeek(`drag-end, dock=${JSON.stringify(dragState.dock)}`);
  stopDragPoll();
  if (petWin && !petWin.isDestroyed()) {
    if (dragState?.dock) {
      if (Number.isFinite(dragState.dock.along)) {
        configStore.data.dock = { ...dragState.dock };
      } else {
        // along 非法：按未停靠收尾——窗口拉回屏内、清停靠，并同步状态。
        // 只清配置不同步渲染层的话，渲染层仍以为在停靠（收起条+点击路由到弹出），
        // 而主进程 setPeek 因 no-dock 全部拒绝 → 悬停/左键全部静默失效
        configStore.data.dock = null;
        peeked = false;
        const cb = petWin.getBounds();
        const wa2 = screen.getDisplayNearestPoint({ x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 }).workArea;
        const nb = {
          x: Math.min(Math.max(cb.x, wa2.x), wa2.x + wa2.width - cb.width),
          y: Math.min(Math.max(cb.y, wa2.y), wa2.y + wa2.height - cb.height),
          width: cb.width,
          height: cb.height,
        };
        petWin.setBounds(nb);
        configStore.data.petPos = { x: nb.x, y: nb.y };
      }
    } else {
      configStore.data.dock = null;
      peeked = false;
      const b = petWin.getBounds();
      configStore.data.petPos = { x: b.x, y: b.y };
    }
    configStore.save();
  }
  dragState = null;
  sendDockState(); // 拖拽结束统一同步一次，任何分支都不允许留状态差
});

ipcMain.on('pet:toggle-memo', () => {
  tracePeek('click → toggle-memo');
  toggleMemo();
});
ipcMain.on('pet:menu', () => { if (petWin) petMenu().popup({ window: petWin }); });
ipcMain.on('pet:peek', (_e, on) => {
  tracePeek(`peek IPC: ${!!on}, docked=${!!configStore.data.dock}, peeked=${peeked}, dragging=${!!dragState}`);
  setPeek(!!on);
});
ipcMain.on('memo:hide', hideMemo);

// ---------- 甘特大窗 ----------
function createGanttWindow() {
  const saved = configStore.data.ganttSize || {};
  const wa = screen.getPrimaryDisplay().workArea;
  // 最大化状态曾被误存为窗口尺寸（getBounds 在最大化时返回整个工作区），异常时回退默认
  let width = saved.width;
  let height = saved.height;
  if (!width || !height || width > wa.width - 40 || height > wa.height - 40) {
    width = 1000;
    height = 640;
  }
  ganttWin = new BrowserWindow({
    width,
    height,
    show: true, // 立即出现：白屏几百毫秒好过"点了没反应"的空窗（用户实测后拍板）
    backgroundColor: '#f4f7f8', // 空窗期用页面同色的软底，比纯白柔和
    title: '甘特图',
    icon: path.join(__dirname, 'assets', 'icon.ico'), // 标题栏/任务栏图标，不用 Electron 默认
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  // 置顶用 floating 层级：高于普通窗口、低于桌宠的 screen-saver
  if (configStore.data.ganttPinned !== false) ganttWin.setAlwaysOnTop(true, 'floating');
  hookDevTools(ganttWin);
  ganttWin.loadFile('gantt.html');
  let saveTimer = null;
  ganttWin.on('resize', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!ganttWin || ganttWin.isDestroyed() || ganttWin.isMaximized()) return; // 最大化尺寸不入库
      configStore.data.ganttSize = ganttWin.getBounds();
      configStore.save();
    }, 400);
  });
  ganttWin.on('close', () => {
    if (ganttWin && !ganttWin.isDestroyed() && !ganttWin.isMaximized()) { // 同上
      configStore.data.ganttSize = ganttWin.getBounds();
      configStore.data.ganttPos = ganttWin.getPosition();
      configStore.save();
    }
  });
  ganttWin.on('closed', () => { ganttWin = null; });
}

function openGantt() {
  if (ganttWin && !ganttWin.isDestroyed()) {
    if (!ganttWin.isVisible()) ganttWin.show();
    ganttWin.focus();
    return;
  }
  createGanttWindow();
}

ipcMain.on('gantt:toggle', () => {
  if (ganttWin && !ganttWin.isDestroyed() && ganttWin.isVisible()) ganttWin.close();
  else openGantt();
});

// ---------- 首次启动：开机启动询问 ----------
function maybeAskAutostart() {
  if (configStore.data.firstRunDone || askWin) return;
  askWin = new BrowserWindow({
    width: 340,
    height: 200,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: '任务清单 · 折页',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  hookDevTools(askWin);
  askWin.loadFile('ask.html');
  askWin.on('closed', () => { askWin = null; });
}

ipcMain.on('ask:answer', (_e, yes) => {
  setAutoStart(!!yes);
  configStore.data.firstRunDone = true;
  configStore.save();
  if (askWin && !askWin.isDestroyed()) askWin.close();
});

// ---------- 到期提醒 ----------
// 甘特表单时间留空会写死 T18:00（默认下班时刻），视为"没有具体时间"
const DEFAULT_DL_TIME = '18:00';
const EARLY_WARN_MS = 5 * 60_000; // 有具体时间的任务提前 5 分钟提醒

function isDueForReminder(t, now) {
  if (t.done || t.remindedAt || !t.deadline) return false;
  const dl = t.deadline;
  const hasTime = dl.length > 10;
  // 有具体时间（且不是默认 18:00）→ 截止前 5 分钟提醒（错过则之后补发一次）
  if (hasTime && dl.slice(11, 16) !== DEFAULT_DL_TIME) {
    const ts = tsOf(dl);
    return Number.isFinite(ts) && now >= ts - EARLY_WARN_MS;
  }
  // 只有日期（或默认 18:00）→ 到期日当天 09:30 提醒（错过则之后补发一次）
  const day = hasTime ? dl.slice(0, 10) : dl;
  const remindAt = new Date(day + 'T09:30:00').getTime();
  return Number.isFinite(remindAt) && now >= remindAt;
}

function scanReminders() {
  if (!Notification.isSupported()) return;
  const now = Date.now();
  const due = tasksStore.data.items.filter((t) => isDueForReminder(t, now));
  if (!due.length) return;
  const stamp = now;
  due.forEach((t) => { t.remindedAt = stamp; });
  tasksStore.save();
  broadcastTasks();
  const first = due[0];
  // 有具体时间的任务可能在截止前就提醒（提前 5 分钟），标题区分"即将/已"
  const upcoming = due.some((t) => hasTimeStr(t.deadline) && t.deadline.slice(11, 16) !== DEFAULT_DL_TIME && now < tsOf(t.deadline));
  const verb = upcoming ? '即将到期' : '已到期';
  const title = due.length === 1
    ? `⏰ 任务${verb}：${first.text.slice(0, 20)}`
    : `⏰ ${due.length} 个任务${verb}`;
  const bodyFull = due.map((t) => t.text).join('；');
  const n = new Notification({
    title,
    body: bodyFull.length > 140 ? bodyFull.slice(0, 137) + '…' : bodyFull,
    silent: false,
  });
  n.on('click', () => openMemo());
  try { n.show(); } catch (_e) { /* 通知失败不影响主流程 */ }
  petWin?.webContents.send('pet:bubble', {
    text: due.length === 1 ? `⏰ ${first.text.slice(0, 14)}` : `⏰ ${due.length} 个任务到期`,
  });
}
setInterval(scanReminders, 30_000);

// ---------- 任务 IPC ----------
function broadcastTasks() {
  for (const w of [memoWin, ganttWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('memo:state', { tasks: tasksStore.data.items });
  }
}

ipcMain.handle('memo:get-state', () => ({ tasks: tasksStore.data.items }));

// 窗口置顶开关（图钉）：floating 层级——压普通窗口、低于桌宠
ipcMain.handle('win:get-pinned', (_e, which) =>
  which === 'gantt' ? configStore.data.ganttPinned !== false : configStore.data.memoPinned !== false);
ipcMain.handle('win:set-pinned', (_e, { which, pinned }) => {
  const on = !!pinned;
  if (which === 'gantt') {
    configStore.data.ganttPinned = on;
    if (ganttWin && !ganttWin.isDestroyed()) ganttWin.setAlwaysOnTop(on, 'floating');
  } else {
    configStore.data.memoPinned = on;
    if (memoWin && !memoWin.isDestroyed()) memoWin.setAlwaysOnTop(on, 'floating');
  }
  configStore.save();
  return true;
});

ipcMain.handle('memo:add-task', (_e, payload) => {
  const text = String(payload?.text ?? '').trim().slice(0, 500);
  if (!text) return null;
  const t = {
    id: uid(),
    text,
    start: String(payload?.start ?? ''),
    deadline: String(payload?.deadline ?? ''),
    desc: String(payload?.desc ?? '').slice(0, 2000),
    done: false,
    createdAt: Date.now(),
    finishedAt: null,
    remindedAt: null,
  };
  tasksStore.data.items.unshift(t);
  tasksStore.save();
  broadcastTasks();
  return t;
});

ipcMain.handle('memo:toggle-done', (_e, { id }) => {
  const t = tasksStore.data.items.find((x) => x.id === id);
  if (!t) return null;
  t.done = !t.done;
  t.finishedAt = t.done ? Date.now() : null;
  tasksStore.save();
  broadcastTasks();
  return t;
});

ipcMain.handle('memo:update-task', (_e, payload) => {
  const t = tasksStore.data.items.find((x) => x.id === payload?.id);
  if (!t) return null;
  if (payload.text !== undefined) {
    const s = String(payload.text).trim().slice(0, 500);
    if (s) t.text = s;
  }
  if (payload.start !== undefined) t.start = String(payload.start);
  if (payload.deadline !== undefined) t.deadline = String(payload.deadline);
  if (payload.desc !== undefined) t.desc = String(payload.desc).slice(0, 2000);
  tasksStore.save();
  broadcastTasks();
  return t;
});

ipcMain.handle('memo:delete-task', (_e, { id }) => {
  tasksStore.data.items = tasksStore.data.items.filter((x) => x.id !== id);
  tasksStore.save();
  broadcastTasks();
  return true;
});

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    trace('whenReady fired');
    app.setAccessibilitySupportEnabled(true); // 供 UIA 自动化测试访问界面元素
    createPet();
    trace('pet window created');
    createTray();
    placePetInitially();
    ensurePeekWatchdog();
    // 清单窗启动时永远隐藏（不恢复上次展开状态），首次点击才出现；预热在下方 1.5s 后台进行
    if (process.argv.includes('--gantt')) openGantt();
    maybeAskAutostart();
    // 预热清单窗：后台提前创建并加载（保持隐藏），首次点击零延迟直接显示。
    // 否则首次点击要现建渲染进程+加载页面（数百毫秒），用户以为没点中而连点
    setTimeout(() => {
      if (!quitting && !memoWin) createMemo();
    }, 1500);
    // 甘特窗不做预热：关窗即销毁，重开反正要重新加载，预热只省首次那一下
    // 却常驻一个渲染进程；打开时的等待由页面内骨架屏+「正在加载」提示兜住
    if (process.argv.includes('--audit')) {
      setTimeout(async () => {
        const dump = {
          displays: screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea })),
          pet: petWin ? { bounds: petWin.getBounds(), visible: petWin.isVisible() } : null,
          memo: memoWin ? { bounds: memoWin.getBounds(), visible: memoWin.isVisible() } : null,
          gantt: ganttWin ? { bounds: ganttWin.getBounds(), visible: ganttWin.isVisible() } : null,
          dock: configStore.data.dock,
          dock: configStore.data.dock,
          petPos: configStore.data.petPos,
          petHeight: configStore.data.petHeight,
          tasks: tasksStore.data.items.length,
          autoStart: getAutoStart(),
          firstRunDone: configStore.data.firstRunDone,
        };
        try {
          if (petWin) {
            dump.renderer = await petWin.webContents.executeJavaScript(
              "({ skin: (typeof manifest !== 'undefined' && manifest) ? manifest.id : null, sheetLoaded: (typeof sheet !== 'undefined') ? !!sheet : null, anim: (typeof anim !== 'undefined') ? anim.name : null })"
            );
          }
        } catch (e) {
          dump.renderer = { error: String(e) };
        }
        console.log('AUDIT ' + JSON.stringify(dump));
        try { fs.writeFileSync(path.join(app.getPath('userData'), 'audit.json'), JSON.stringify(dump, null, 2)); } catch (_e) { /* 尽力而为 */ }
        // 再等 6 秒复查图集是否加载完成（网络服务崩溃重启后的恢复情况）
        setTimeout(async () => {
          try {
            if (petWin) {
              dump.renderer2 = await petWin.webContents.executeJavaScript(
                "({ sheetLoaded: (typeof sheet !== 'undefined') ? !!sheet : null, anim: (typeof anim !== 'undefined') ? anim.name : null })"
              );
            }
          } catch (e) { /* 复查失败不影响退出 */ }
          console.log('AUDIT2 ' + JSON.stringify(dump));
          app.quit();
        }, 6000);
      }, 4000);
    }
  });

  app.on('second-instance', () => {
    if (petWin && !petWin.isDestroyed()) petWin.show();
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    quitting = true;
    try {
      if (petWin && !petWin.isDestroyed() && !configStore.data.dock) {
        const b = petWin.getBounds();
        configStore.data.petPos = { x: b.x, y: b.y };
      }
      configStore.data.expanded = !!(memoWin && !memoWin.isDestroyed() && memoWin.isVisible());
      configStore.save();
    } catch (_e) { /* 退出时保存尽力而为 */ }
  });
}