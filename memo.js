let tasks = [];
let currentTab = 'today';
let editingId = null; // 弹窗当前编辑的任务 id；null = 新增

const DAY = 86400000;
const listEl = document.getElementById('task-list');
const emptyEl = document.getElementById('empty-hint');
const badgeEls = {
  today: document.getElementById('badge-today'),
  week: document.getElementById('badge-week'),
  future: document.getElementById('badge-future'),
};

const dlgEl = document.getElementById('task-dialog');
const tdTitleEl = document.getElementById('td-title');
const tdTextEl = document.getElementById('td-text');
const tdDescEl = document.getElementById('td-desc');
const tdSdEl = document.getElementById('td-sd');
const tdStEl = document.getElementById('td-st');
const tdDdEl = document.getElementById('td-dd');
const tdDtEl = document.getElementById('td-dt');

const EMPTY_HINTS = {
  today: '今天没有要处理的任务～',
  week: '本周（周一～周日）暂无任务',
  future: '长远计划是空的；开始和完成时间都留空即「待安排」',
  history: '还没有完成记录',
};

// ---------- 基础事件 ----------
document.getElementById('close-btn').addEventListener('click', () => window.memoAPI.hide());
document.getElementById('gantt-btn').addEventListener('click', () => window.ganttAPI.toggle());

// 置顶图钉：激活=压在其他窗口上（仍低于桌宠）
const pinBtn = document.getElementById('pin-btn');
function applyPinUi(pinned) {
  pinBtn.classList.toggle('active', pinned);
  pinBtn.title = pinned ? '取消置顶（不再压其他窗口）' : '窗口置顶（压其他窗口、仍低于桌宠）';
}
pinBtn.addEventListener('click', async () => {
  const pinned = !pinBtn.classList.contains('active');
  applyPinUi(pinned);
  await window.memoAPI.setPinned(pinned);
});
window.memoAPI.getPinned().then(applyPinUi);
window.addEventListener('contextmenu', (e) => e.preventDefault());

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  selectTab(btn.dataset.tab);
  render();
});

function selectTab(name) {
  currentTab = name;
  document.querySelectorAll('#tabs .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
}

// ---------- 时间工具 ----------
function pad(n) { return String(n).padStart(2, '0'); }

function localDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 完成时间：'' → Infinity；"YYYY-MM-DD" 按当天 18:00 算（默认下班时刻）；带 T 时刻按本地时间
function deadlineTs(str) {
  if (!str) return Infinity;
  return str.length === 10
    ? new Date(str + 'T18:00:00').getTime()
    : new Date(str).getTime();
}

// 开始时间：日期按当天 09:00 起（默认上班时刻）
function startTs(str) {
  if (!str) return NaN;
  return str.length === 10
    ? new Date(str + 'T09:00:00').getTime()
    : new Date(str).getTime();
}

function hasTime(str) { return !!str && str.length > 10; }

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 年内省年份、跨年带年份的 "MM-DD"（或 "YYYY-MM-DD"）
function mdSmart(d) {
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

// 完成于：今年 MM-DD HH:MM，跨年 YYYY-MM-DD HH:MM
function fmtFinished(ts) {
  const d = new Date(ts);
  return `${mdSmart(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 短日期：今天/明天/昨天/M-D（跨年带年份），行1 ✓ 完成态用
function fmtDeadlineShort(str) {
  if (!str) return '待安排';
  const d = new Date(deadlineTs(str));
  const dayDiff = Math.round((startOfDay(d) - startOfDay(new Date())) / DAY);
  if (dayDiff === 0) return '今天';
  if (dayDiff === 1) return '明天';
  if (dayDiff === -1) return '昨天';
  return mdSmart(d);
}

// 行1 右侧截止相对日期（不带时刻）：
// 今天 / 明天 / 本自然周内 → 周X；已逾期 → 已逾期；超出本周 → 长远
function fmtDeadlineSmart(str) {
  if (!str) return '';
  const d = new Date(deadlineTs(str));
  if (isNaN(d)) return '';
  const diff = Math.round((startOfDay(d) - startOfDay(new Date())) / DAY);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff < 0) return '已逾期';
  const mondayOf = (x) => {
    const t = startOfDay(x);
    t.setDate(t.getDate() - (t.getDay() + 6) % 7); // 回退到本周一
    return t.getTime();
  };
  if (mondayOf(d) === mondayOf(new Date())) return WEEK_CN[d.getDay()];
  return '长远';
}

// 行2 截止日期和时间：MM-DD HH:MM（跨年带年份；纯日期截止只写日期）
function fmtDeadlineFull(str) {
  if (!str) return '';
  const d = new Date(deadlineTs(str));
  if (isNaN(d)) return '';
  const hm = hasTime(str) ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
  return mdSmart(d) + hm;
}

function descSummary(d) {
  const first = d.split('\n')[0];
  return first.length > 40 ? first.slice(0, 40) + '…' : first;
}

// ---------- 分区引擎（三视图模型） ----------
// 今天 = 行动视图：时间窗与今天有交叠（逾期 / 今日截止 / 进行中交叠）
// 本周 = 周报视图：自然周一~周日，逾期块 + 按截止日分组 + 本周完成（按 finishedAt 落周）
// 长远 = 日历视图：按截止日归属，进行中的任务同样出现（行上加「进行中」标）
function partition(list) {
  const now = Date.now();
  const today0 = startOfDay(new Date()).getTime();
  const tomorrow0 = today0 + DAY;
  const dow = (new Date(today0).getDay() + 6) % 7;
  const monday0 = today0 - dow * DAY; // 本周一 0:00（本周 tab 的窗口起点）
  const nextMonday0 = today0 - dow * DAY + 7 * DAY;

  const p = {
    today: { overdue: [], due: [], ongoing: [], done: [] },
    week: { overdue: [], todo: [], done: [] },
    future: { todo: [], somedayTodo: [], somedayDone: [], done: [] },
  };

  for (const t of list) {
    const dl = t.deadline ? deadlineTs(t.deadline) : null;
    if (t.done) {
      const fin = t.finishedAt || 0;
      if (fin < monday0) continue; // 本周之前的完成记录由历史 tab 承载
      if (dl == null && !t.start) { p.future.somedayDone.push(t); continue; } // 都没有
      const anchor = dl ?? startTs(t.start); // 无截止的开口任务按开始日归档
      if (fin >= today0 && anchor < tomorrow0) p.today.done.push(t); // 今天完成的照旧驻留今日
      p.week.done.push(t); // 完成时间在本周 → 本周已完成（周报口径，与锚点无关）
      continue;
    }
    if (dl == null && !t.start) { p.future.somedayTodo.push(t); continue; } // 都没有 → 待安排
    if (dl == null) { // 只有开始时间：开口任务（无固定截止）
      if (startTs(t.start) < tomorrow0) { p.today.ongoing.push(t); continue; } // 已开始 → 仅今日「进行中」（开口任务无截止日，无日历锚点可归档）
      const sd = startOfDay(new Date(startTs(t.start))).getTime();
      if (sd < nextMonday0) p.week.todo.push(t); // 未开始 → 按开始日进本周/长远
      else p.future.todo.push(t);
      continue;
    }
    if (dl < now) { // 已过截止时刻：今日逾期块兜底，截止在本周内的同时进本周逾期块
      p.today.overdue.push(t);
      if (dl >= monday0) p.week.overdue.push(t);
      continue;
    }
    if (dl < tomorrow0) { p.today.due.push(t); p.week.todo.push(t); continue; } // 今天截止、时刻未到：今日块 + 本周「今天」组
    // 已开始（开始日 ≤ 今天）且截止在之后 → 进行中交叠：今日驻留，同时按截止日照常进本周/长远
    if (t.start && startTs(t.start) < tomorrow0) p.today.ongoing.push(t);
    if (dl < nextMonday0) p.week.todo.push(t);
    else p.future.todo.push(t);
    continue;
  }

  // 归档锚点：有截止按截止时刻，无截止的开口任务按开始时刻
  const anchorTs = (t) => (t.deadline ? deadlineTs(t.deadline) : startTs(t.start));
  const byAnchor = (a, b) => anchorTs(a) - anchorTs(b);
  const byFinishedDesc = (a, b) => (b.finishedAt || 0) - (a.finishedAt || 0);
  for (const arr of [p.today.overdue, p.today.due, p.today.ongoing, p.week.overdue, p.week.todo, p.future.todo]) {
    arr.sort(byAnchor);
  }
  for (const k of ['today', 'week', 'future']) p[k].done.sort(byFinishedDesc);
  p.future.somedayDone.sort(byFinishedDesc);
  return p;
}

function historyGroups(list) {
  const done = list.filter((t) => t.done)
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  const today0 = startOfDay(new Date()).getTime();
  const groups = [];
  const map = new Map();
  for (const t of done) {
    const day0 = startOfDay(new Date(t.finishedAt || 0)).getTime();
    if (!map.has(day0)) {
      const d0 = new Date(day0);
      const diff = Math.round((today0 - day0) / DAY);
      const label = diff === 0 ? '今天'
        : diff === 1 ? '昨天'
        : d0.getFullYear() === new Date().getFullYear() ? localDateStr(d0).slice(5)
        : localDateStr(d0);
      const g = { label, items: [] };
      map.set(day0, g);
      groups.push(g);
    }
    map.get(day0).items.push(t);
  }
  return groups;
}

// ---------- 渲染 ----------
function render() {
  const p = partition(tasks);
  setBadge('today', p.today.overdue.length + p.today.due.length + p.today.ongoing.length, p.today.overdue.length > 0);
  setBadge('week', p.week.overdue.length + p.week.todo.length, p.week.overdue.length > 0);
  setBadge('future', p.future.todo.length + p.future.somedayTodo.length, false);
  listEl.textContent = '';
  if (currentTab === 'history') renderHistory();
  else if (currentTab === 'today') renderToday(p.today);
  else if (currentTab === 'week') renderWeek(p.week);
  else renderPartition(currentTab, p);
}

function setBadge(name, n, overdue) {
  badgeEls[name].textContent = String(n);
  badgeEls[name].classList.toggle('overdue', overdue);
}

// ---------- 分组头：相点 + 标题 + 右侧日期 ----------
const WK_CHARS = ['一', '二', '三', '四', '五', '六', '日'];

function dayHead(label, right, cls) {
  const li = document.createElement('li');
  li.className = 'day-head' + (cls ? ' ' + cls : '');
  const dot = document.createElement('span');
  dot.className = 'dot';
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  li.append(dot, labelEl);
  if (right) {
    const r = document.createElement('span');
    r.className = 'dh-date';
    r.textContent = right;
    li.appendChild(r);
  }
  return li;
}

// 分组标题：今天 · 周三 / 明天 · 周四 / 周五（本周内）/ M月D日 · 周X
function dayLabel(day0, today0) {
  const d = new Date(day0);
  const diff = Math.round((day0 - today0) / DAY);
  const wk = '周' + WK_CHARS[(d.getDay() + 6) % 7];
  if (diff === 0) return '今天 · ' + wk;
  if (diff === 1) return '明天 · ' + wk;
  if (diff > 1) return wk;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return (sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`) + ' · ' + wk;
}

function dayRight(day0) {
  const d = new Date(day0);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return sameYear ? localDateStr(d).slice(5) : localDateStr(d);
}

// 今天 tab：行动视图三块（逾期 / 今日截止 / 进行中交叠）+ 今天完成的
function renderToday(v) {
  const now = Date.now();
  const blocks = [
    ['逾期', v.overdue, 'overdue-h'],
    ['今日截止', v.due, 'due-h'],
    ['进行中', v.ongoing, 'ongoing-h'],
  ];
  for (const [label, items, cls] of blocks) {
    if (!items.length) continue;
    listEl.appendChild(dayHead(label, items.length + ' 条', cls));
    for (const t of items) listEl.appendChild(renderItem(t, now));
  }
  if (v.done.length) {
    listEl.appendChild(dayHead('已完成', v.done.length + ' 条', 'muted-h'));
    for (const t of v.done) listEl.appendChild(renderItem(t, now));
  }
  emptyEl.textContent = EMPTY_HINTS.today;
  emptyEl.hidden = v.overdue.length + v.due.length + v.ongoing.length + v.done.length > 0;
}

// 按锚点日（截止 ?? 开始）分组；items 已按锚点升序，分组天然有序
function groupByDay(items) {
  const groups = [];
  const map = new Map();
  for (const t of items) {
    const day0 = startOfDay(new Date(t.deadline ? deadlineTs(t.deadline) : startTs(t.start))).getTime();
    if (!map.has(day0)) {
      const g = { day0, items: [] };
      map.set(day0, g);
      groups.push(g);
    }
    map.get(day0).items.push(t);
  }
  return groups;
}

// 本周 tab：周报视图 = 逾期块 + 按截止日分组（周一~周日，含今天）+ 本周已完成
function renderWeek(v) {
  const now = Date.now();
  const today0 = startOfDay(new Date()).getTime();
  if (v.overdue.length) {
    listEl.appendChild(dayHead('逾期', v.overdue.length + ' 条', 'overdue-h'));
    for (const t of v.overdue) listEl.appendChild(renderItem(t, now));
  }
  for (const g of groupByDay(v.todo)) {
    listEl.appendChild(dayHead(dayLabel(g.day0, today0), dayRight(g.day0)));
    for (const t of g.items) listEl.appendChild(renderItem(t, now));
  }
  if (v.done.length) {
    listEl.appendChild(dayHead('已完成', v.done.length + ' 条', 'muted-h'));
    for (const t of v.done) listEl.appendChild(renderItem(t, now));
  }
  emptyEl.textContent = EMPTY_HINTS.week;
  emptyEl.hidden = v.overdue.length + v.todo.length + v.done.length > 0;
}

// 长远 tab：日历视图，按截止日分组（进行中的任务照常出现，行上加「进行中」标）
function renderPartition(name, p) {
  const { todo, done } = p[name];
  const now = Date.now();
  const today0 = startOfDay(new Date()).getTime();

  for (const g of groupByDay(todo)) {
    listEl.appendChild(dayHead(dayLabel(g.day0, today0), dayRight(g.day0)));
    for (const t of g.items) listEl.appendChild(renderItem(t, now));
  }
  if (name === 'future') {
    if (p.future.somedayTodo.length || p.future.somedayDone.length) {
      listEl.appendChild(dayHead('待安排', '', 'muted-h'));
      for (const t of p.future.somedayTodo) listEl.appendChild(renderItem(t, now));
      for (const t of p.future.somedayDone) listEl.appendChild(renderItem(t, now));
    }
  }
  if (done.length) {
    listEl.appendChild(dayHead('已完成', done.length + ' 条', 'muted-h'));
    for (const t of done) listEl.appendChild(renderItem(t, now));
  }
  const total = todo.length + done.length
    + (name === 'future' ? p.future.somedayTodo.length + p.future.somedayDone.length : 0);
  emptyEl.textContent = EMPTY_HINTS[name];
  emptyEl.hidden = total > 0;
}

function renderHistory() {
  for (const g of historyGroups(tasks)) {
    listEl.appendChild(dayHead(g.label, g.items.length + ' 条', 'muted-h'));
    for (const t of g.items) listEl.appendChild(renderItem(t, Date.now()));
  }
  emptyEl.textContent = EMPTY_HINTS.history;
  emptyEl.hidden = listEl.children.length > 0;
}

// ---------- 任务详情悬浮（自绘 tooltip） ----------
let detailTip = null;
function ensureTip() {
  if (detailTip) return detailTip;
  detailTip = document.createElement('div');
  detailTip.id = 'detail-tip';
  detailTip.hidden = true;
  document.body.appendChild(detailTip);
  return detailTip;
}
function showDetailTip(desc, e) {
  const tip = ensureTip();
  tip.textContent = '';
  if (desc) {
    const d = document.createElement('div');
    d.className = 'tip-desc';
    d.textContent = desc;
    tip.appendChild(d);
  }
  const h = document.createElement('div');
  h.className = 'tip-hint';
  h.textContent = '双击编辑（内容/时间/描述）';
  tip.appendChild(h);
  tip.hidden = false;
  moveDetailTip(e);
}
function moveDetailTip(e) {
  if (!detailTip || detailTip.hidden) return;
  const pad = 12;
  let x = e.clientX + 14, y = e.clientY + 16;
  const w = detailTip.offsetWidth, h = detailTip.offsetHeight;
  if (x + w > window.innerWidth - pad) x = e.clientX - w - 14;
  if (y + h > window.innerHeight - pad) y = e.clientY - h - 12;
  detailTip.style.left = Math.max(pad, x) + 'px';
  detailTip.style.top = Math.max(pad, y) + 'px';
}
function hideDetailTip() {
  if (detailTip) detailTip.hidden = true;
}
listEl.addEventListener('scroll', hideDetailTip);

function renderItem(t, now) {
  const li = document.createElement('li');
  li.dataset.id = t.id;
  const notStarted = !t.done && t.start && startTs(t.start) > now;
  // 进行中：已开始且未到期（跨天任务在「今天」驻留期间标注；开口任务无截止也成立）
  const ongoing = !t.done && !notStarted && t.start && startTs(t.start) <= now
    && (!t.deadline || startOfDay(new Date(deadlineTs(t.deadline))).getTime() > startOfDay(new Date(now)).getTime());
  li.className = 'item'
    + (t.done ? ' done' : '')
    + (!t.done && deadlineTs(t.deadline) < now ? ' overdue' : '')
    + (notStarted ? ' not-started' : '');
  // 悬浮提示：自绘 tooltip（原生 title 宽度无上限，长描述会横贯窗口）——
  // 收窄到 300px 自动换行，超长限高滚动，位置跟随光标且防出屏
  const tipDesc = t.desc ? t.desc.trim() : '';
  li.addEventListener('mouseenter', (e) => showDetailTip(tipDesc, e));
  li.addEventListener('mousemove', moveDetailTip);
  li.addEventListener('mouseleave', hideDetailTip);

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'check';
  check.checked = t.done;
  check.title = t.done ? '取消完成（回到对应分区）' : '完成';
  check.addEventListener('change', () => window.memoAPI.toggleDone(t.id));

  const body = document.createElement('div');
  body.className = 'body';

  // 行1：标题 + 右对齐日期（短格式）
  const row1 = document.createElement('div');
  row1.className = 't-row1';
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = t.text;
  if (notStarted) {
    const flag = document.createElement('i');
    flag.className = 'flag';
    flag.textContent = '未开始';
    text.appendChild(flag);
  } else if (ongoing) {
    const flag = document.createElement('i');
    flag.className = 'flag ongoing';
    flag.textContent = '进行中';
    text.appendChild(flag);
  }
  // 行1右对齐：截止相对日期（今天/明天/周X/已逾期/长远）/ 无截止 / 待安排 / 完成 ✓ 日期
  const timeEl = document.createElement('div');
  timeEl.className = 't-time';
  if (t.done && t.finishedAt) {
    timeEl.textContent = '✓ ' + fmtDeadlineShort(localDateStr(new Date(t.finishedAt)));
  } else {
    timeEl.textContent = t.deadline ? fmtDeadlineSmart(t.deadline)
      : t.start ? '无截止'
      : '待安排';
  }
  row1.append(text, timeEl);
  body.appendChild(row1);

  // 行2：截止日期和时间 + 描述摘要（均无则整行省略；完成态显示完成于）
  const row2 = document.createElement('div');
  row2.className = 't-row2';
  if (t.done && t.finishedAt) {
    const fin = document.createElement('span');
    fin.textContent = '完成于 ' + fmtFinished(t.finishedAt);
    row2.appendChild(fin);
  } else {
    // 行2：截止日期和时间（开始时间不展示，想看点开详情）；有描述追加摘要
    if (t.deadline) {
      const range = document.createElement('span');
      range.className = 't-range';
      range.textContent = fmtDeadlineFull(t.deadline);
      row2.appendChild(range);
    }
    if (t.desc) {
      const d = document.createElement('span');
      d.className = 't-desc';
      d.textContent = descSummary(t.desc);
      row2.appendChild(d);
    }
  }
  if (row2.children.length) body.appendChild(row2);

  const del = document.createElement('button');
  del.className = 'del';
  del.type = 'button';
  del.textContent = '✕';
  del.title = '删除（不进历史）';
  del.addEventListener('click', () => window.memoAPI.deleteTask(t.id));

  li.append(check, body, del);
  // 双击整条 → 打开编辑弹窗（勾选框与删除按钮除外）
  li.addEventListener('dblclick', (e) => {
    if (e.target.closest('.check') || e.target.closest('.del')) return;
    openDialog(t);
  });
  return li;
}

// ---------- 任务弹窗（新增 / 编辑一体） ----------
function dateAfterDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}

function openDialog(t) {
  editingId = t ? t.id : null;
  tdTitleEl.textContent = t ? '编辑任务' : '添加任务';
  tdTextEl.value = t ? t.text : '';
  tdDescEl.value = (t && t.desc) || '';
  if (t) {
    // 只回填任务实际拥有的时间：避免编辑时把空时间悄悄补成默认值
    // （否则无截止的开口任务一保存就会被塞进「今天 18:00」的截止时间）
    tdSdEl.value = (t.start || '').slice(0, 10);
    tdStEl.value = hasTime(t.start) ? t.start.slice(11, 16) : '';
    tdDdEl.value = (t.deadline || '').slice(0, 10);
    tdDtEl.value = hasTime(t.deadline) ? t.deadline.slice(11, 16) : '';
  } else {
    // 默认：今天上午 09:00 → 今天下午 18:00
    const today = localDateStr(new Date());
    tdSdEl.value = today; tdStEl.value = '09:00';
    tdDdEl.value = today; tdDtEl.value = '18:00';
  }
  dlgEl.hidden = false;
  tdTextEl.focus();
}

function closeDialog() {
  editingId = null;
  dlgEl.hidden = true;
}

document.getElementById('add-btn').addEventListener('click', () => openDialog(null));
document.getElementById('td-close').addEventListener('click', closeDialog);
document.getElementById('td-cancel').addEventListener('click', closeDialog);
// 点弹窗遮罩（卡片之外）关闭
dlgEl.addEventListener('mousedown', (e) => { if (e.target === dlgEl) closeDialog(); });

document.getElementById('td-save').addEventListener('click', () => {
  const text = tdTextEl.value.trim();
  if (!text) { tdTextEl.focus(); return; }
  const start = tdSdEl.value ? tdSdEl.value + 'T' + (tdStEl.value || '09:00') : '';
  const deadline = tdDdEl.value ? tdDdEl.value + 'T' + (tdDtEl.value || '18:00') : '';
  const desc = tdDescEl.value.trim().slice(0, 2000);
  if (editingId) {
    window.memoAPI.updateTask({ id: editingId, text, start, deadline, desc });
  } else {
    const created = window.memoAPI.addTask({ text, start, deadline, desc });
    if (created) {
      pendingFlashId = created.id;
      setTimeout(() => { pendingFlashId = null; }, 5000);
    }
  }
  closeDialog();
});

// 弹窗内快捷日期 chip：设置完成日期
document.getElementById('td-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const k = chip.dataset.quick;
  if (k === 'none') {
    tdSdEl.value = ''; tdStEl.value = '';
    tdDdEl.value = ''; tdDtEl.value = '';
  } else {
    const n = { today: 0, tomorrow: 1, dayafter: 2 }[k];
    tdDdEl.value = dateAfterDays(n);
    if (!tdStEl.value) tdStEl.value = '09:00';
    if (!tdDtEl.value) tdDtEl.value = '18:00';
  }
});

[tdTextEl, tdDescEl, tdSdEl, tdStEl, tdDdEl, tdDtEl].forEach((x) => {
  x.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDialog();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) document.getElementById('td-save').click();
  });
});

// ---------- 闪光反馈 ----------
let pendingFlashId = null;

function tryFlash() {
  if (!pendingFlashId) return;
  const el = listEl.querySelector(`[data-id="${pendingFlashId}"]`);
  if (el) {
    el.classList.add('flash');
    el.scrollIntoView({ block: 'nearest' });
    pendingFlashId = null;
  }
}

// ---------- 状态 ----------
window.memoAPI.onState((s) => { tasks = s.tasks; render(); tryFlash(); });
window.memoAPI.getState().then((s) => { tasks = s.tasks; render(); tryFlash(); });

// 跨天自动重算；正在弹窗编辑时跳过，避免打断输入
setInterval(() => { if (!dlgEl.hidden) return; if (!listEl.querySelector('input:focus')) render(); }, 60000);
