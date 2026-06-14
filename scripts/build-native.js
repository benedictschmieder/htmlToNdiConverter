// Builds the native NDI sender addon against the locally installed Electron
// runtime headers, so the resulting .node file loads inside Electron.
//
// Run automatically on `npm install` (postinstall) and via `npm run build:native`.

const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

function getElectronVersion() {
  try {
    return require("electron/package.json").version;
  } catch (e) {
    return null;
  }
}

function main() {
  const electronVersion = getElectronVersion();

  const env = { ...process.env };
  const args = ["rebuild"];

  if (electronVersion) {
    // Build against Electron's bundled Node headers.
    env.npm_config_runtime = "electron";
    env.npm_config_target = electronVersion;
    env.npm_config_disturl = "https://electronjs.org/headers";
    env.npm_config_arch = "x64";
    env.npm_config_target_arch = "x64";
    args.push(`--target=${electronVersion}`);
    args.push("--arch=x64");
    args.push("--dist-url=https://electronjs.org/headers");
    console.log(
      `[build-native] Building addon for Electron ${electronVersion} ...`,
    );
  } else {
    console.log(
      "[build-native] Electron not found, building for system Node.js ...",
    );
  }

  const nodeGyp = path.join(
    __dirname,
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "node-gyp.cmd" : "node-gyp",
  );

  const bin = fs.existsSync(nodeGyp) ? nodeGyp : "node-gyp";

  try {
    execFileSync(bin, args, {
      stdio: "inherit",
      env,
      shell: process.platform === "win32",
    });
  } catch (err) {
    console.error("\n[build-native] Native build failed.");
    console.error("[build-native] Make sure the following are installed:");
    console.error(
      '  - Visual Studio Build Tools with "Desktop development with C++"',
    );
    console.error("  - NDI 6 SDK (default: C:\\Program Files\\NDI\\NDI 6 SDK)");
    console.error(
      "    or set the NDI_SDK_DIR environment variable to its location.",
    );
    process.exit(1);
  }
}

main();
