// npm run dev 的启动包装：清理会破坏 Electron 的宿主环境变量后拉起 electronmon。
// ELECTRON_RUN_AS_NODE=1（VS Code 集成终端 / 某些 Electron 宿主终端会泄漏）会让
// require('electron') 退化成纯 Node，electronmon 直接崩溃（hook.js: electron.app undefined）。
// 用法不变：npm run dev（等价于先 unset ELECTRON_RUN_AS_NODE 再 electronmon .）
const { spawn } = require('child_process');
const path = require('path');

delete process.env.ELECTRON_RUN_AS_NODE;

const pkgPath = require.resolve('electronmon/package.json');
const pkg = require(pkgPath);
const cli = path.join(path.dirname(pkgPath), pkg.bin.electronmon);

// 关键：electronmon cli 转发参数时若收到空数组，不会应用默认的 '.'（应用路径），
// electron 就会启动自带的欢迎示例页（表现为：npm run dev 后只见 Electron demo 窗口）
const appArgs = process.argv.slice(2);
const child = spawn(process.execPath, [cli, ...(appArgs.length ? appArgs : ['.'])], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code || 0);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
