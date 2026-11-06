// 静态形象模式：桌宠以最早期的静态贴图呈现
const staticImg = document.getElementById('static-fallback');
const bubble = document.getElementById('bubble');

// ---------- 停靠状态（主进程把窗口裁成收起条，贴图保持全身尺寸由窗口裁切；peeked=悬停弹出的全身态） ----------
let peekMode = 'hover'; // hover=悬停弹出（默认）/ pinned=固定收起
window.petAPI.onDockState(({ docked, side, peeked, pet, peekMode: mode }) => {
  const b = document.body;
  if (mode) peekMode = mode;
  b.classList.toggle('docked', !!docked);
  b.classList.toggle('peeked', !!docked && !!peeked);
  b.classList.remove('side-top', 'side-bottom', 'side-left', 'side-right');
  if (docked && side) b.classList.add('side-' + side);
  // 全身尺寸（px）：收起态贴图按它渲染，窗口只露出一条
  if (pet) b.style.setProperty('--pet', pet + 'px');
  if (docked) b.classList.remove('grabbing');
});

// ---------- 加速球式收放：停靠时鼠标移入露出条 → 主进程弹出全身；移开 → 收回 ----------
document.body.addEventListener('mouseenter', () => {
  const b = document.body;
  if (b.classList.contains('docked') && !b.classList.contains('grabbing')) {
    window.petAPI.setPeek(true);
  }
});
document.body.addEventListener('mouseleave', () => {
  if (document.body.classList.contains('docked')) {
    window.petAPI.setPeek(false);
  }
});

// ---------- 提醒气泡 ----------
let bubbleTimer = 0;
window.petAPI.onBubble(({ text }) => {
  bubble.textContent = text;
  bubble.hidden = false;
  bubble.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    bubble.classList.remove('show');
    setTimeout(() => { bubble.hidden = true; }, 300);
  }, 6000);
});

// ---------- 拖拽 / 单击 / 右键（事件挂 body，贴图元素通用） ----------
// 按下即进入拖拽；松手时位移极小且按压时间短 → 视为单击，切换清单窗
let pressX = 0, pressY = 0, pressAt = 0;
document.body.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  document.body.classList.add('grabbing');
  pressX = e.screenX;
  pressY = e.screenY;
  pressAt = Date.now();
  window.petAPI.dragStart();
});

function endDrag() {
  document.body.classList.remove('grabbing');
  window.petAPI.dragEnd();
}

window.addEventListener('mouseup', (e) => {
  endDrag();
  if (e.button !== 0) return;
  const moved = Math.hypot(e.screenX - pressX, e.screenY - pressY);
  if (moved < 5 && Date.now() - pressAt < 500) {
    const b = document.body;
    // 悬停弹出模式：收起态点击 → 先弹出全身（加速球交互）；
    // 固定收起模式：点击直接开关清单；弹出态/自由态点击 → 开关清单
    if (b.classList.contains('docked') && !b.classList.contains('peeked') && peekMode === 'hover') {
      window.petAPI.setPeek(true);
    } else {
      window.petAPI.toggleMemo();
    }
  }
});
window.addEventListener('blur', endDrag);

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.petAPI.showMenu();
});
