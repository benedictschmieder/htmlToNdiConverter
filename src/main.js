// HTML to NDI Converter - Electron main process
//
// Renders the configured URL in an offscreen Chromium window and forwards every
// painted frame (BGRA) to the native NDI sender addon, which publishes it as an
// NDI video source on the network.

const { app, BrowserWindow } = require("electron");
const path = require("path");
const config = require("./config");

// ---------------------------------------------------------------------------
// Load the native NDI sender addon.
// ---------------------------------------------------------------------------
function loadAddon() {
  const candidates = [
    path.join(__dirname, "..", "build", "Release", "ndi_sender.node"),
    // Packaged (asarUnpack) location.
    path.join(
      process.resourcesPath || "",
      "app.asar.unpacked",
      "build",
      "Release",
      "ndi_sender.node",
    ),
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch (err) {
      // try next
    }
  }
  throw new Error(
    'Could not load native addon ndi_sender.node. Run "npm run build:native".',
  );
}

let addon;
try {
  addon = loadAddon();
} catch (err) {
  console.error("[fatal]", err.message);
  app.quit();
  process.exit(1);
}

// Software offscreen rendering yields CPU-accessible BGRA bitmaps in the
// "paint" event, which is exactly what NDI needs. GPU OSR delivers a shared
// texture instead, so disabling HW acceleration keeps things simple/robust.
if (config.disableHardwareAcceleration) {
  app.disableHardwareAcceleration();
}

// Keep producing frames even when the window is hidden / not focused.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

let win = null;
let sender = null;
let senderW = 0;
let senderH = 0;
let reloadTimer = null;

function ensureSender(width, height) {
  if (sender && width === senderW && height === senderH) {
    return;
  }
  if (sender) {
    try {
      sender.destroy();
    } catch (e) {
      /* ignore */
    }
    sender = null;
  }
  sender = new addon.NdiSender(config.ndiName);
  senderW = width;
  senderH = height;
  console.log(`[ndi] Source "${config.ndiName}" @ ${width}x${height}`);
}

function scheduleReload(reason) {
  if (reloadTimer) return;
  const secs = Math.max(1, config.reloadOnFailureSeconds || 5);
  console.warn(`[reload] ${reason} - retrying in ${secs}s`);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    if (win && !win.isDestroyed()) {
      win.loadURL(config.url).catch((e) => scheduleReload(e.message));
    }
  }, secs * 1000);
}

function createWindow() {
  win = new BrowserWindow({
    width: config.width,
    height: config.height,
    show: false,
    frame: false,
    transparent: config.transparent,
    backgroundColor: config.transparent ? "#00000000" : "#000000",
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.webContents.setAudioMuted(true);
  win.webContents.setFrameRate(config.fps);

  win.webContents.on("paint", (event, dirty, image) => {
    try {
      const size = image.getSize();
      if (size.width === 0 || size.height === 0) return;
      ensureSender(size.width, size.height);
      const bitmap = image.getBitmap(); // BGRA, length = w*h*4
      sender.send(
        bitmap,
        size.width,
        size.height,
        config.frameRateNumerator,
        config.frameRateDenominator,
      );
    } catch (err) {
      console.error("[paint]", err.message);
    }
  });

  win.webContents.on("did-fail-load", (e, code, desc, url, isMainFrame) => {
    if (isMainFrame) scheduleReload(`did-fail-load (${code} ${desc})`);
  });

  win.webContents.on("render-process-gone", (e, details) => {
    scheduleReload(`render-process-gone (${details.reason})`);
  });

  win.webContents.on("unresponsive", () => {
    scheduleReload("renderer unresponsive");
  });

  win.loadURL(config.url).catch((e) => scheduleReload(e.message));
}

app.whenReady().then(() => {
  console.log(
    `[start] URL=${config.url} size=${config.width}x${config.height} ` +
      `fps=${config.fps} transparent=${config.transparent}`,
  );
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (sender) {
    try {
      sender.destroy();
    } catch (e) {
      /* ignore */
    }
    sender = null;
  }
});

// Single instance: a second launch should not fight over the NDI name.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}
