// 生成应用图标 assets/icon.ico —— 「对勾折页」纯矢量设计（与折页角色贴图完全脱钩）
// 管线（v3，根治"小尺寸图形缩在一角"）：
//   1) 离屏窗口固定 256px 视口，把 SVG 渲染一次（不再按档位缩窗口——
//      Windows 最小窗口宽度约 40px，会把小尺寸图挤进视口左上角）
//   2) 纯数学盒式(area-weighted)降采样 256 → 各档位，零外部缩放器、零 DPI 干扰
//   3) 手工组装 ICO：≤64px 用 BMP 条目，96px+ 用 PNG 条目
// 16/20/24/32 用加粗简化形（折角放大、对勾加粗），48+ 用完整构图
// 运行方式：npm run icon（= electron scripts/make-icon.js）
const fs = require('fs');
const path = require('path');

// 本机全局设置了 ELECTRON_RUN_AS_NODE=1，npm run 会把它带进来导致 electron 降级成纯 node。
// 检测到就剥掉该变量并用当前可执行文件（electron 二进制）重启自身。
if (process.env.ELECTRON_RUN_AS_NODE) {
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(process.execPath, [__filename], { stdio: 'inherit', env });
  process.exit(r.status || 0);
}

const { app, nativeImage, BrowserWindow } = require('electron');

const outDir = path.join(__dirname, '..', 'assets', 'icon-sizes');
const icoPath = path.join(__dirname, '..', 'assets', 'icon.ico');

const TEAL = '#2F8F86';   // 项目主题青碧
const MIST = '#BFE3DD';   // 雾青（折角）

const SRC = 256;          // 渲染源尺寸（离屏视口，稳定可靠）
const SMALL_MAX = 32;     // ≤32px 用简化形
const SIZES = [16, 20, 24, 32, 48, 64, 96, 128, 256];

// 精细版（48px+ 档）：完整构图
const DETAIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">`
  + `<rect width="96" height="96" rx="22" fill="${TEAL}"/>`
  + `<path d="M 32 20 H 58 L 72 34 V 68 Q 72 76 64 76 H 32 Q 24 76 24 68 V 28 Q 24 20 32 20 Z" fill="#FFFFFF"/>`
  + `<path d="M 58 20 L 72 34 H 58 Z" fill="${MIST}"/>`
  + `<path d="M 36 48 L 45 57 L 62 38" stroke="${TEAL}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`
  + `</svg>`;

// 简化版（16/20/24/32px 档）：折角放大（细折角会消失）、对勾加粗
const SMALL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">`
  + `<rect width="96" height="96" rx="22" fill="${TEAL}"/>`
  + `<path d="M 32 18 H 52 L 72 38 V 66 Q 72 76 62 76 H 34 Q 24 76 24 66 V 28 Q 24 18 34 18 Z" fill="#FFFFFF"/>`
  + `<path d="M 52 18 L 72 38 H 52 Z" fill="${MIST}"/>`
  + `<path d="M 35 50 L 45 60 L 62 41" stroke="${TEAL}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`
  + `</svg>`;

app.disableHardwareAcceleration(); // 离屏渲染走软件光栅化，保证截帧稳定

// 固定 256px 视口渲染 SVG（win 复用，bg 传入纯色背景）
// capturePage 会把透明背景合成掉，所以改用双背景差分（difference keying）：
//   同一图形在纯白/纯黑背景各渲染一次，Cw = fg + (1-α)*255，Cb = fg*α
//   → α = 1 - (Cw-Cb)/255，premultiplied fg = Cb，数学上精确，边缘无光晕
async function rasterOnce(win, svg, bg) {
  const imgB64 = Buffer.from(svg).toString('base64');
  const html = `<html><body style="margin:0;overflow:hidden;background:${bg}">`
    + `<img src="data:image/svg+xml;base64,${imgB64}" width="${SRC}" height="${SRC}" style="display:block"></body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await win.webContents.executeJavaScript(
    'new Promise(r => { const i = document.querySelector("img"); if (i.complete) r(); else { i.onload = () => r(); i.onerror = () => r(); } })'
  );
  await new Promise(r => setTimeout(r, 120)); // 留合成时间
  const shot = await win.webContents.capturePage();
  const img = shot.getSize().width === SRC ? shot : shot.resize({ width: SRC, height: SRC });
  return Buffer.from(img.toBitmap()); // BGRA（premultiplied 语义不适用，纯色底直读）
}

// 差分求解 premultiplied BGRA
function diffKey(whiteBmp, blackBmp) {
  const out = Buffer.alloc(SRC * SRC * 4);
  for (let i = 0; i < SRC * SRC; i++) {
    const o = i * 4;
    let maxDiff = 0;
    for (let c = 0; c < 3; c++) maxDiff = Math.max(maxDiff, whiteBmp[o + c] - blackBmp[o + c]);
    const a = Math.max(0, Math.min(255, 255 - maxDiff));
    out[o] = blackBmp[o]; out[o + 1] = blackBmp[o + 1]; out[o + 2] = blackBmp[o + 2];
    out[o + 3] = a;
  }
  // 硬校验：四角必须透明（圆角外），中心必须不透明——防止图形缩角/背景污染
  const px = (x, y) => out[(y * SRC + x) * 4 + 3];
  if (px(0, 0) > 8 || px(SRC - 1, 0) > 8 || px(0, SRC - 1) > 8 || px(SRC - 1, SRC - 1) > 8) {
    throw new Error('渲染校验失败：画布四角不透明，图形没有铺满视口');
  }
  if (px(SRC >> 1, SRC >> 1) < 200) {
    throw new Error('渲染校验失败：画布中心透明，图形没有铺满视口');
  }
  return out;
}

// 盒式降采样（area-weighted）： premultiplied BGRA 256 → target
// 对 premultiplied 颜色做面积加权平均在数学上是正确的，边缘无光晕
function boxDownscale(src, target) {
  const out = Buffer.alloc(target * target * 4);
  const scale = SRC / target;
  for (let ty = 0; ty < target; ty++) {
    const y0 = Math.floor(ty * scale), y1 = Math.min(SRC, Math.ceil((ty + 1) * scale));
    for (let tx = 0; tx < target; tx++) {
      const x0 = Math.floor(tx * scale), x1 = Math.min(SRC, Math.ceil((tx + 1) * scale));
      let b = 0, g = 0, r = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * SRC + x) * 4;
          b += src[i]; g += src[i + 1]; r += src[i + 2]; a += src[i + 3]; n++;
        }
      }
      const o = (ty * target + tx) * 4;
      out[o] = Math.round(b / n); out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(r / n); out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// premultiplied BGRA → straight BGRA（ICO 的 BMP 条目要求非预乘）
function unpremultiply(pm, w, h) {
  const out = Buffer.from(pm);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4, a = out[o + 3];
    if (a > 0 && a < 255) {
      for (let c = 0; c < 3; c++) {
        out[o + c] = Math.min(255, Math.round(out[o + c] * 255 / a));
      }
    }
  }
  return out;
}

// 单个条目 → ICO BMP 格式（BITMAPINFOHEADER + 自底向上 XOR + AND 掩码全 0）
function bmpEntry(bgra, w, h) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);          // biSize
  header.writeInt32LE(w, 4);            // biWidth
  header.writeInt32LE(h * 2, 8);        // biHeight = XOR + AND
  header.writeUInt16LE(1, 12);          // biPlanes
  header.writeUInt16LE(32, 14);         // biBitCount
  header.writeUInt32LE(0, 16);          // biCompression = BI_RGB
  const rowBytes = w * 4;
  const maskRow = Math.ceil(w / 32) * 4;
  const xor = Buffer.alloc(rowBytes * h);
  for (let y = 0; y < h; y++) {
    // 自底向上：BMP 第 0 行 = 图像最后一行
    bgra.copy(xor, (h - 1 - y) * rowBytes, y * rowBytes, (y + 1) * rowBytes);
  }
  const and = Buffer.alloc(maskRow * h); // 有 alpha 通道时 AND 掩码全 0 即可
  return Buffer.concat([header, xor, and]);
}

function pngEntry(pm, w, h) {
  return nativeImage.createFromBitmap(pm, { width: w, height: h }).toPNG();
}

function assembleICO(entries) {
  // entries: [{size, data, isPng}]
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const blobs = [];
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0; dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);               // planes
    dir.writeUInt16LE(e.isPng ? 32 : 32, o + 6); // bitCount
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    blobs.push(e.data);
    offset += e.data.length;
  });
  return Buffer.concat([header, dir, ...blobs]);
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    fs.mkdirSync(outDir, { recursive: true });

    // 两个变体 × 双背景（白/黑）差分渲染（复用同一离屏窗口），再降采样到各自的档位
    const win = new BrowserWindow({
      width: SRC, height: SRC, show: false, frame: false,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    async function renderVariant(svg) {
      const w = await rasterOnce(win, svg, '#ffffff');
      const b = await rasterOnce(win, svg, '#000000');
      return diffKey(w, b);
    }
    const detailSrc = await renderVariant(DETAIL_SVG);
    const smallSrc = await renderVariant(SMALL_SVG);
    win.destroy();

    const entries = [];
    for (const s of SIZES) {
      const src = s <= SMALL_MAX ? smallSrc : detailSrc;
      const pm = boxDownscale(src, s);
      // 预览 PNG 存档（premultiplied 喂给 createFromBitmap）
      fs.writeFileSync(path.join(outDir, `icon-${s}.png`),
        nativeImage.createFromBitmap(pm, { width: s, height: s }).toPNG());
      entries.push({
        size: s,
        // ≤64 用 BMP 条目（兼容性最好）；96+ 用 PNG 条目（体积小）
        data: s <= 64 ? bmpEntry(unpremultiply(pm, s, s), s, s) : pngEntry(pm, s, s),
        isPng: s > 64,
      });
      console.log(`${s}px ✓`);
    }

    const ico = assembleICO(entries);
    fs.writeFileSync(icoPath, ico);
    console.log(`ICO 已生成: ${icoPath} (${ico.length} bytes, ${SIZES.length} 档)`);
  } catch (e) {
    console.error('生成图标失败:', e.message);
    code = 1;
  } finally {
    app.exit(code);
  }
});
