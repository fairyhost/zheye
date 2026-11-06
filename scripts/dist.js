/**
 * npm run dist 入口：按版本号组织打包产物目录。
 *
 * 用法：
 *   npm run dist      -> 输出到项目内 release/<version>/
 *   npm run dist:d    -> 输出到 D:/build/折页/<version>/
 *   npm run dist:t    -> 输出到 release/<version>-<时间戳>/，并把 exe / yml / blockmap
 *                        另存一份到 release/latest/ 方便上传
 *
 * 关于 dist:t：
 * electron-builder 每轮打包开始都会先清空输出目录里的 win-unpacked。若上一轮生成的
 * app.asar 仍被编辑器索引、杀软扫描或同步盘等进程占用，清空就会失败并报
 *   The process cannot access the file ... app.asar: it is being used by another process
 * 时间戳目录每次都是全新空目录，清空这一步无事可做，可稳定绕过该问题。
 * 代价是旧目录不会自动清理，待系统重启释放句柄后手动删除即可。
 *
 * 输出结构示例（version=1.0.0）：
 *   release/1.0.0/{ZheYe-Setup-1.0.0.exe, ZheYe-Portable-1.0.0.exe, win-unpacked/}
 * 同版本重复打包时 electron-builder 自动覆盖重建该版本目录。
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const pkg = require(path.join(__dirname, "..", "package.json"));
const root = path.join(__dirname, "..");
const mode = process.argv[2] || ""; // "" | "d" | "t"

const pad = (n) => String(n).padStart(2, "0");
const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

let outDir;
if (mode === "d") {
  outDir = path.join("D:", "build", "折页", pkg.version);
} else if (mode === "t") {
  outDir = path.join(root, "release", `${pkg.version}-${stamp()}`);
} else {
  outDir = path.join(root, "release", pkg.version);
}

const cliJs = path.join(__dirname, "..", "node_modules", "electron-builder", "cli.js");

console.log(`[dist] version=${pkg.version} mode=${mode || "default"} -> output=${outDir}`);

const res = spawnSync(
  process.execPath,
  [cliJs, "--win", "-c.directories.output=" + outDir],
  { stdio: "inherit" }
);

if (res.status !== 0) {
  process.exit(res.status || 1);
}

// 时间戳模式：把要上传的文件另存一份到 release/latest/，省得去时间戳目录里翻
if (mode === "t") {
  const latestDir = path.join(root, "release", "latest");
  try {
    fs.mkdirSync(latestDir, { recursive: true });
    const picked = fs.readdirSync(outDir).filter((f) => /\.(exe|yml|blockmap)$/i.test(f));
    for (const f of picked) {
      fs.copyFileSync(path.join(outDir, f), path.join(latestDir, f));
    }
    console.log(`\n[dist] 待上传文件已汇总到 ${latestDir}`);
    picked.forEach((f) => console.log(`       - ${f}`));
    console.log(`[dist] 打包目录（含 win-unpacked，勿上传）：${outDir}\n`);
  } catch (e) {
    console.warn(`[dist] 汇总到 latest 失败（不影响产物本身）：${e.message}`);
  }
}
