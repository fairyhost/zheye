/**
 * npm run dist 入口：按版本号组织打包产物目录。
 *
 * 用法：
 *   npm run dist      -> 输出到项目内 release/<version>/
 *   npm run dist:d    -> 输出到 D:/build/折页/<version>/
 *
 * 输出结构示例（version=1.0.0）：
 *   release/1.0.0/{ZheYe-Setup-1.0.0.exe, ZheYe-Portable-1.0.0.exe, win-unpacked/}
 * 同版本重复打包时 electron-builder 自动覆盖重建该版本目录。
 */
const path = require("path");
const { spawnSync } = require("child_process");

const pkg = require(path.join(__dirname, "..", "package.json"));
const toDDisk = process.argv[2] === "d";
const outDir = toDDisk
  ? path.join("D:", "build", "折页", pkg.version)
  : path.join(__dirname, "..", "release", pkg.version);
const cliJs = path.join(__dirname, "..", "node_modules", "electron-builder", "cli.js");

console.log(`[dist] version=${pkg.version} -> output=${outDir}`);

const res = spawnSync(
  process.execPath,
  [cliJs, "--win", "-c.directories.output=" + outDir],
  { stdio: "inherit" }
);

process.exit(res.status || 1);
