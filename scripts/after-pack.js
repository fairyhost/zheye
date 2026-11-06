/**
 * afterPack hook: run rcedit on the packed exe with a generous retry loop.
 *
 * Why: 奇安信天擎 / ThreatBook real-time scanning races with rcedit's
 * EndUpdateResource, producing "Fatal error: Unable to commit changes".
 * electron-builder's built-in step retries only 3 times with short delays and
 * gives up. Here we retry up to 15 times with 3s intervals, which is enough
 * for the AV scan to release the handle.
 *
 * Requires build.win.signAndEditExecutable = false so electron-builder's own
 * rcedit step is skipped.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");

const MAX_ATTEMPTS = 15;
const RETRY_INTERVAL_MS = 3000;

function findRcedit() {
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const cacheRoot = path.join(
    localAppData,
    "electron-builder",
    "Cache",
    "winCodeSign"
  );
  const versions = fs
    .readdirSync(cacheRoot)
    .filter((d) => /^winCodeSign-/.test(d))
    .sort()
    .reverse();
  for (const v of versions) {
    const p = path.join(cacheRoot, v, "rcedit-x64.exe");
    if (fs.existsSync(p)) return p;
  }
  throw new Error("rcedit-x64.exe not found under " + cacheRoot);
}

function runRcedit(rcedit, exePath, args) {
  return new Promise((resolve, reject) => {
    execFile(
      rcedit,
      [exePath, ...args],
      { windowsHide: true, timeout: 60000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(String(stderr || err.message).trim()));
        } else {
          resolve();
        }
      }
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const appOutDir = context.appOutDir;
  const exeCandidates = fs
    .readdirSync(appOutDir)
    .filter((f) => f.endsWith(".exe"));
  if (exeCandidates.length === 0) {
    throw new Error("after-pack: no exe found in " + appOutDir);
  }
  const exePath = path.join(appOutDir, exeCandidates[0]);

  const appInfo = context.packager.appInfo;
  const version = appInfo.version;
  const productVersion =
    version.split(".").length === 3 ? version + ".0" : version;
  const iconPath = path.resolve(__dirname, "..", "assets", "icon.ico");

  const args = [
    "--set-version-string",
    "FileDescription",
    appInfo.description || appInfo.productName,
    "--set-version-string",
    "ProductName",
    appInfo.productName,
    "--set-version-string",
    "LegalCopyright",
    appInfo.copyright,
    "--set-file-version",
    version,
    "--set-product-version",
    productVersion,
    "--set-version-string",
    "InternalName",
    path.basename(exePath, ".exe"),
    "--set-version-string",
    "OriginalFilename",
    "",
    "--set-version-string",
    "CompanyName",
    appInfo.companyName,
  ];
  if (fs.existsSync(iconPath)) {
    args.push("--set-icon", iconPath);
  }

  const rcedit = findRcedit();
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await runRcedit(rcedit, exePath, args);
      console.log(`[after-pack] rcedit OK (attempt ${attempt}) -> ${exePath}`);
      return;
    } catch (e) {
      lastError = e;
      console.warn(
        `[after-pack] rcedit attempt ${attempt}/${MAX_ATTEMPTS} failed: ${e.message}`
      );
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_INTERVAL_MS);
    }
  }
  throw new Error(
    `after-pack: rcedit failed after ${MAX_ATTEMPTS} attempts: ${lastError}`
  );
};
