// 甘特大窗：时间全景视图（粒度 14/28/56 天，就地编辑，双窗数据同步）
let tasks = [];
let ganttOffset = 0; // 单位：周
let viewDays = 28;   // 粒度：14 / 28 / 56
let editingId = null;

const DAY = 86400000;
const NAME_W = 170; // 左侧任务名列固定宽；时间轴列宽按窗口实际宽度动态分配（任何粒度都铺满、不留白不滚动）

// 今日标记样式（⚙ 配置面板可切换，localStorage 记忆）
const TODAY_STYLES = ['dash', 'solid', 'flag', 'fill', 'chan'];
let todayStyle = localStorage.getItem('gantt-today-style') || 'dash';
if (!TODAY_STYLES.includes(todayStyle)) todayStyle = 'dash';

// 无截止开口条的尾部样式：fade 渐隐淡出(默认) / arrow 箭头收尾
const OPEN_TAILS = ['fade', 'arrow'];
let openTail = localStorage.getItem('gantt-open-tail') || 'fade';
if (!OPEN_TAILS.includes(openTail)) openTail = 'fade';

const gridEl = document.getElementById('grid');
const gridwrapEl = document.getElementById('gridwrap');
const gTitleEl = document.getElementById('g-title');
const gCountEl = document.getElementById('g-count');
const rangeTitleEl = document.getElementById('range-title');
const legendEl = document.getElementById('legend');
const outnoteEl = document.getElementById('outnote');
const somedayEl = document.getElementById('someday');
const hintEl = document.getElementById('hint');
const editorEl = document.getElementById('editor');
const eNameEl = document.getElementById('e-name');
const eSdEl = document.getElementById('e-sd');
const eStEl = document.getElementById('e-st');
const eDdEl = document.getElementById('e-dd');
const eDtEl = document.getElementById('e-dt');

// ---------- 时间工具 ----------
function pad(n) { return String(n).padStart(2, '0'); }

function localDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 完成时间：日期按当天 18:00 算（默认下班时刻）；开始时间：日期按当天 09:00 起
function deadlineTs(str) {
  if (!str) return Infinity;
  return str.length === 10
    ? new Date(str + 'T18:00:00').getTime()
    : new Date(str).getTime();
}

function startTs(str) {
  if (!str) return NaN;
  return str.length === 10
    ? new Date(str + 'T09:00:00').getTime()
    : new Date(str).getTime();
}

function hasTime(str) { return !!str && str.length > 10; }

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

function fmtDeadline(str, fallbackHm = '18:00') {
  if (!str) return '待安排';
  const d = new Date(deadlineTs(str));
  const dayDiff = Math.round((startOfDay(d) - startOfDay(new Date())) / DAY);
  const hm = hasTime(str) ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : ` ${fallbackHm}`;
  if (dayDiff === 0) return '今天' + hm;
  if (dayDiff === 1) return '明天' + hm;
  if (dayDiff === -1) return '昨天' + hm;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}${hm}`;
}

// ---------- 渲染 ----------
const LEGEND = [
  ['进行中', 'linear-gradient(180deg, #35978f, #2b847b)'],
  ['已完成', '#b9d9d5'],
  ['逾期', '#d05e52'],
  ['未开始', '#ccd8dd'],
];

function render() {
  // 数据首次渲染完成，撤掉启动骨架屏（之后的 render 调用元素已移除，no-op）
  document.getElementById('boot-skeleton')?.remove();
  const today0 = startOfDay(new Date()).getTime();
  const monday0 = today0 - ((new Date(today0).getDay() + 6) % 7) * DAY;
  const rangeStart = monday0 + ganttOffset * 7 * DAY;
  const rangeEnd = rangeStart + viewDays * DAY;
  const now = Date.now();

  // 时间轴列宽：按窗口实际宽度均分，14/28/56 天都正好铺满整幅宽度
  const dayW = Math.max(0, gridwrapEl.clientWidth - NAME_W) / viewDays;

  gCountEl.textContent = '共 ' + tasks.filter((t) => t.deadline || (!t.done && t.start)).length + ' 条计划';
  const s = new Date(rangeStart);
  const e = new Date(rangeEnd - DAY);
  rangeTitleEl.textContent = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())} ~ ${pad(e.getMonth() + 1)}-${pad(e.getDate())}`;

  gridEl.textContent = '';

  const planned = tasks.filter((t) => t.deadline);
  const openEnded = tasks.filter((t) => !t.done && !t.deadline && t.start); // 只有开始时间 → 开口条
  const someday = tasks.filter((t) => !t.done && !t.deadline && !t.start);  // 都没有 → 仅列行名
  const inRange = [
    ...planned.filter((t) => {
      const dEnd = startOfDay(deadlineTs(t.deadline)).getTime() + DAY;
      const drawStart = t.start ? startOfDay(startTs(t.start)).getTime() : (dEnd > today0 ? today0 : dEnd - DAY);
      return drawStart < rangeEnd && dEnd > rangeStart;
    }),
    // 开口条：开始日在窗口内或之前即在窗内（条向右延伸到窗口右缘）
    ...openEnded.filter((t) => startOfDay(startTs(t.start)).getTime() < rangeEnd),
  ].sort((a, b) => {
    const sa = a.start ? startTs(a.start) : deadlineTs(a.deadline);
    const sb = b.start ? startTs(b.start) : deadlineTs(b.deadline);
    const ea = a.deadline ? deadlineTs(a.deadline) : Infinity;
    const eb = b.deadline ? deadlineTs(b.deadline) : Infinity;
    return (sa - sb) || (ea - eb) || a.text.localeCompare(b.text, 'zh');
  });

  // 图例
  legendEl.textContent = '';
  for (const [name, color] of LEGEND) {
    const item = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.style.background = color;
    item.append(swatch, name);
    legendEl.appendChild(item);
  }

  // 表头：月份行 + 日期行，角格贯穿两行并居中（CSS Grid）
  const head = document.createElement('div');
  head.className = 'g-header';
  head.style.gridTemplateColumns = NAME_W + 'px repeat(' + viewDays + ', ' + dayW + 'px)';
  const corner = document.createElement('div');
  corner.className = 'g-corner';
  corner.textContent = '按完成时间排列';
  head.appendChild(corner);
  let mi = 0;
  while (mi < viewDays) {
    const d = new Date(rangeStart + mi * DAY);
    const m = d.getMonth();
    let span = 0;
    while (mi + span < viewDays && new Date(rangeStart + (mi + span) * DAY).getMonth() === m) span++;
    const mcell = document.createElement('div');
    mcell.className = 'g-month'
      + (rangeStart + mi * DAY <= today0 && today0 < rangeStart + (mi + span) * DAY ? ' istoday-m' : '');
    mcell.style.gridColumn = 'span ' + span;
    mcell.textContent = (m + 1) + '月';
    head.appendChild(mcell);
    mi += span;
  }
  for (let i = 0; i < viewDays; i++) {
    const d = new Date(rangeStart + i * DAY);
    const cell = document.createElement('div');
    cell.className = 'g-cell';
    if (i % 7 === 0) cell.classList.add('wkstart');
    if (i % 7 >= 5) cell.classList.add('wknd');
    if (rangeStart + i * DAY === today0) cell.classList.add('istoday');
    cell.textContent = String(d.getDate());
    head.appendChild(cell);
  }
  // 第三行：周几
  const DOW_CHARS = ['一', '二', '三', '四', '五', '六', '日'];
  for (let i = 0; i < viewDays; i++) {
    const cell = document.createElement('div');
    cell.className = 'g-dow'
      + (i % 7 === 0 ? ' wkstart' : '')
      + (i % 7 >= 5 ? ' wknd' : '')
      + (rangeStart + i * DAY === today0 ? ' istoday' : '');
    cell.textContent = DOW_CHARS[i % 7];
    head.appendChild(cell);
  }
  gridEl.appendChild(head);

  // 连续周末色带：一整块底层，从表头下沿（叠住 1px 边线）贯通到底；
  // 周末列的分段色块画在色带层里（宽度随 dayW 动态计算）
  const bands = document.createElement('div');
  bands.className = 'g-bands';
  bands.style.left = NAME_W + 'px';
  bands.style.width = (viewDays * dayW) + 'px';
  bands.style.top = (head.offsetHeight - 1) + 'px';
  // 周末色带：只在周六落一块（宽度含周日），避免只画周日漏掉周六
  for (let i = 0; i < viewDays; i++) {
    if (i % 7 !== 5) continue; // i=0 是周一，5=周六、6=周日
    const span = Math.min(2, viewDays - i);
    const seg = document.createElement('div');
    seg.className = 'g-band';
    seg.style.left = (i * dayW) + 'px';
    seg.style.width = (span * dayW) + 'px';
    bands.appendChild(seg);
  }
  gridEl.appendChild(bands);

  // 今日标记：样式由 ⚙ 配置面板选择（dash 虚线 / solid 实线+三角 / flag 旗标 / fill 整列底色 / chan 夹线通道）
  let todayMark = null;
  if (today0 >= rangeStart && today0 < rangeEnd) {
    const todayIdx = Math.round((today0 - rangeStart) / DAY);
    const mark = document.createElement('div');
    mark.className = 'g-today g-today--' + todayStyle;
    if (todayStyle === 'fill' || todayStyle === 'chan') {
      mark.style.left = (NAME_W + todayIdx * dayW) + 'px';
      mark.style.width = dayW + 'px';
    } else {
      mark.style.left = (NAME_W + (todayIdx + 0.5) * dayW) + 'px';
    }
    mark.style.top = (head.offsetHeight - 1) + 'px';
    gridEl.appendChild(mark);
    todayMark = mark;
  }

  // 行高：任务少时按窗口高度均分撑满（上限 64px），纵观全局不留大片空白
  const availH = Math.max(0, gridwrapEl.clientHeight - head.offsetHeight);
  const rowH = inRange.length ? Math.max(40, Math.min(64, Math.floor(availH / inRange.length))) : 40;
  gridEl.style.setProperty('--rowh', rowH + 'px');

  // 任务行：两行行名（名称 + 时间区间）
  for (const t of inRange) {
    const row = document.createElement('div');
    row.className = 'g-row';

    const name = document.createElement('div');
    name.className = 'g-name';
    name.title = '点击编辑名称与时间';
    name.addEventListener('click', () => openEditor(t));
    const gnName = document.createElement('span');
    gnName.className = 'gn-name';
    gnName.textContent = t.text;
    gnName.title = t.text;
    const gnTime = document.createElement('span');
    gnTime.className = 'gn-time';
    gnTime.textContent = (t.start ? fmtDeadline(t.start, '09:00') + ' → ' : '') + (t.deadline ? fmtDeadline(t.deadline) : '无截止');
    name.append(gnName, gnTime);
    row.appendChild(name);

    const track = document.createElement('div');
    track.className = 'g-track';
    track.style.width = (viewDays * dayW) + 'px';

    // 无截止的开口条：dEnd 取窗口右缘，条向右延伸、虚线收尾
    const dEnd = t.deadline ? startOfDay(deadlineTs(t.deadline)).getTime() + DAY : rangeEnd;
    const drawStart = t.start ? startOfDay(startTs(t.start)).getTime() : (dEnd > today0 ? today0 : dEnd - DAY);
      const leftPx = Math.max(0, (drawStart - rangeStart) / DAY) * dayW;
      const rightPx = Math.min(viewDays, (dEnd - rangeStart) / DAY) * dayW;
      const widthPx = Math.max(rightPx - leftPx, dayW * 0.8);
      const chanW = Math.min(widthPx, viewDays * dayW - leftPx);

      const chan = document.createElement('div');
      chan.className = 'g-chan'
        + (t.done ? ' done' : '')
        + (!t.deadline ? ' open open--' + openTail : '')
        + (!t.done && t.deadline && deadlineTs(t.deadline) < now ? ' overdue' : '')
        + (!t.done && t.start && startTs(t.start) > now ? ' notstarted' : '');
      chan.style.left = leftPx + 'px';
      chan.style.width = chanW + 'px';
      chan.title = `${t.text}（${t.start ? fmtDeadline(t.start, '09:00') + ' → ' : ''}${t.deadline ? fmtDeadline(t.deadline) : '无截止'}）`;
      chan.addEventListener('click', () => openEditor(t));
      // 条宽够（>110px）时把任务名写进条内。
      // 文字层与条块拆开（同为 track 的子元素、独立层级）：今日标记 z2 压在条上（z-auto），
      // 文字 z3 又压在标记上 —— 实现「标记在条之上、文字之下」；
      // pointer-events:none 让点击/悬浮穿透到条块
      if (chanW > 110) {
      const bl = document.createElement('span');
      bl.className = 'bl';
      bl.textContent = t.text;
      bl.style.left = leftPx + 'px';
      bl.style.width = chanW + 'px';
      track.appendChild(bl);
    }
    track.appendChild(chan);

    row.appendChild(track);
    gridEl.appendChild(row);
  }

  if (!inRange.length) {
    const hint = document.createElement('div');
    hint.style.cssText = 'padding:32px;text-align:center;color:#b0b5b0;font-size:12px;';
    hint.textContent = (planned.length || openEnded.length)
      ? '当前窗口内没有计划，用左右箭头按钮翻页'
      : '还没有已排期的任务：给任务填上开始或完成时间，就会出现在这里';
    gridEl.appendChild(hint);
  }

  // 覆盖层（色带/今日标记）高度：按「内容高度 vs 容器可视高度」取大者显式设置，保证贯通到底。
  // 注意 clientHeight 是取整值，弹性布局下真实可用高度常带小数（如 410.6 记成 411），
  // 直接采用会比实际空间多出亚像素，导致内容未满也出现滚动条，故容器侧 -1 兜底
  const overlayBottom = Math.max(gridEl.offsetHeight, gridwrapEl.clientHeight - 1);
  const overlayH = Math.max(0, overlayBottom - head.offsetHeight + 1) + 'px';
  bands.style.height = overlayH;
  if (todayMark) todayMark.style.height = overlayH;

  // 行名列右缘线：从网格顶部贯通到底（行/表头区域内与原有 border-right 重合，空白区域由此线补齐）
  // left = NAME_W - 1：border-left 画在 169~170px，与行内 border-right（盒子内侧 169~170px）精确重合，避免错位显粗
  const nameRule = document.createElement('div');
  nameRule.className = 'g-name-rule';
  nameRule.style.left = (NAME_W - 1) + 'px';
  nameRule.style.height = overlayBottom + 'px';
  gridEl.appendChild(nameRule);

  const plannedIn = inRange.filter((t) => t.deadline).length;
  const outCount = planned.length - plannedIn;
  outnoteEl.hidden = outCount === 0;
  outnoteEl.textContent = outCount > 0 ? `另有 ${outCount} 条计划不在当前窗口内，用左右箭头按钮翻页查看` : '';
  somedayEl.hidden = someday.length === 0;
  somedayEl.textContent = someday.length ? '待安排：' + someday.map((t) => t.text).join('、') : '';

  // 编辑中的任务被删了就收起面板
  if (editingId && !tasks.some((t) => t.id === editingId)) closeEditor();
}

// ---------- 就地编辑（时间默认 09:00 / 18:00） ----------
function openEditor(t) {
  editingId = t.id;
  eNameEl.value = t.text;
  eNameEl.title = t.text;
  // 只回填任务实际拥有的时间：无截止的开口任务 / 待安排任务保存后保持原状，不被塞进默认时间
  eSdEl.value = (t.start || '').slice(0, 10);
  eStEl.value = hasTime(t.start) ? t.start.slice(11, 16) : '';
  eDdEl.value = (t.deadline || '').slice(0, 10);
  eDtEl.value = hasTime(t.deadline) ? t.deadline.slice(11, 16) : '';
  editorEl.hidden = false;
  render(); // 面板改变了网格区高度：行高/覆盖层按新高度重算，否则旧尺寸溢出出现滚动条
}

function closeEditor() {
  editingId = null;
  editorEl.hidden = true;
  render(); // 同上：面板收起后网格区变高，行高重新撑满
}

document.getElementById('e-cancel').addEventListener('click', closeEditor);

editorEl.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!editingId) return;
  const text = eNameEl.value.trim();
  const start = eSdEl.value ? eSdEl.value + 'T' + (eStEl.value || '09:00') : '';
  const deadline = eDdEl.value ? eDdEl.value + 'T' + (eDtEl.value || '18:00') : '';
  window.memoAPI.updateTask({ id: editingId, text, start, deadline });
  closeEditor();
});

[eSdEl, eStEl, eDdEl, eDtEl].forEach((x) => {
  x.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeEditor();
  });
});

// ---------- 工具条 ----------
document.getElementById('prev-btn').addEventListener('click', () => { ganttOffset -= 1; render(); });
document.getElementById('next-btn').addEventListener('click', () => { ganttOffset += 1; render(); });
document.querySelectorAll('#gran-seg .gran').forEach((b) => {
  b.addEventListener('click', () => {
    viewDays = Number(b.dataset.days);
    document.querySelectorAll('#gran-seg .gran').forEach((x) => x.classList.toggle('active', x === b));
    render();
  });
});

// 今日标记样式配置面板
const cfgBtnEl = document.getElementById('cfg-btn');

// 置顶图钉：激活=压在其他窗口上（仍低于桌宠）
const pinBtnEl = document.getElementById('pin-btn');
function applyGanttPinUi(pinned) {
  pinBtnEl.classList.toggle('active', pinned);
  pinBtnEl.title = pinned ? '取消置顶（不再压其他窗口）' : '窗口置顶（压其他窗口、仍低于桌宠）';
}
pinBtnEl.addEventListener('click', async () => {
  const pinned = !pinBtnEl.classList.contains('active');
  applyGanttPinUi(pinned);
  await window.ganttAPI.setPinned(pinned);
});
window.ganttAPI.getPinned().then(applyGanttPinUi);

const cfgPanelEl = document.getElementById('cfg-panel');
const cfgRadios = document.querySelectorAll('input[name="today-style"]');

function applyTodayStyle(v) {
  todayStyle = TODAY_STYLES.includes(v) ? v : 'dash';
  localStorage.setItem('gantt-today-style', todayStyle);
  cfgRadios.forEach((r) => { r.checked = r.value === todayStyle; });
  cfgPanelEl.hidden = true;
  render();
}

cfgRadios.forEach((r) => r.addEventListener('change', () => applyTodayStyle(r.value)));
cfgRadios.forEach((r) => { r.checked = r.value === todayStyle; });

// 今日标记颜色：⚙ 面板取色器实时调整（压在条上后的区分度由用户自调），localStorage 记忆
// 默认 rgb(244,11,11) 红；旧默认 #2f8f86 视为未自定义，自动迁移到新默认
const TODAY_C_DEFAULT = '#f40b0b';
const TODAY_C_LEGACY_DEFAULT = '#2f8f86';
const colorInputEl = document.getElementById('today-color');
const colorResetEl = document.getElementById('today-color-reset');

function applyTodayColor(v, save = true) {
  const c = /^#[0-9a-fA-F]{6}$/.test(v || '') ? v.toLowerCase() : TODAY_C_DEFAULT;
  document.documentElement.style.setProperty('--today-c', c);
  if (save) localStorage.setItem('gantt-today-color', c);
  if (colorInputEl.value.toLowerCase() !== c) colorInputEl.value = c;
}

// input 事件：拖取色器时实时预览并记忆
colorInputEl.addEventListener('input', () => applyTodayColor(colorInputEl.value));
colorResetEl.addEventListener('click', () => applyTodayColor(TODAY_C_DEFAULT));
const storedColor = (localStorage.getItem('gantt-today-color') || '').toLowerCase();
applyTodayColor(!storedColor || storedColor === TODAY_C_LEGACY_DEFAULT ? TODAY_C_DEFAULT : storedColor, false);

// 开口条尾部样式配置（fade / arrow / dots）
const tailRadios = document.querySelectorAll('input[name="open-tail"]');

function applyOpenTail(v) {
  openTail = OPEN_TAILS.includes(v) ? v : 'fade';
  localStorage.setItem('gantt-open-tail', openTail);
  tailRadios.forEach((r) => { r.checked = r.value === openTail; });
  cfgPanelEl.hidden = true;
  render();
}

tailRadios.forEach((r) => {
  r.checked = r.value === openTail;
  r.addEventListener('change', () => applyOpenTail(r.value));
});

cfgBtnEl.addEventListener('click', (e) => {
  e.stopPropagation();
  cfgPanelEl.hidden = !cfgPanelEl.hidden;
});
cfgPanelEl.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', (e) => {
  if (!cfgPanelEl.hidden && !cfgPanelEl.contains(e.target)) cfgPanelEl.hidden = true;
});

// 窗口尺寸变化时按新宽度重排（列宽始终铺满）
window.addEventListener('resize', render);

for (const [name, color] of LEGEND) {
  const item = document.createElement('span');
  const swatch = document.createElement('i');
  swatch.style.background = color;
  item.append(swatch, name);
  legendEl.appendChild(item);
}

// ---------- 状态同步（与主清单窗双向实时） ----------
window.memoAPI.onState((s) => { tasks = s.tasks; render(); });
window.memoAPI.getState().then((s) => { tasks = s.tasks; render(); });
