// HTML to NDI Converter - Electron main process
//
// Renders the configured URL in an offscreen Chromium window and forwards every
// painted frame (BGRA) to the native NDI sender addon, which publishes it as an
// NDI video source on the network.

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  shell,
} = require("electron");
const path = require("path");
const logger = require("./logger");

// Single instance: a second launch must not fight over the NDI name.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Start file logging before anything else so early failures are captured.
logger.init();
logger.patchConsole();

const config = require("./config");

// ---------------------------------------------------------------------------
// Service status (surfaced in the tray).
// ---------------------------------------------------------------------------
const status = {
  state: "starting", // starting | loading | streaming | error
  detail: "",
  size: "",
};
let tray = null;

// Embedded 32x32 tray icon (blue ring + play glyph) so no binary asset is
// needed in the package.
const TRAY_ICON_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAnElEQVR4nO2UyxGAMAhEqcR6bdQ61HMm" +
  "CbAs+JkwwxHfy5ogsupLte3HaenHwCkiKDwsMfrgXTJrmogXrImUwkMSLDgswYT3JMqih1KIwmfzqQKW" +
  "55oiMFtAqQKWDZgi4FnB/0zgNXeg5BUgu2A0a15EkRRaoPv0rBS036MKMCUgOEsiBO8JWEVGc24BTcTa" +
  "MJghQYEjInTwqsy6ABMbB/igIZVQAAAAAElFTkSuQmCC";

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

// ---------------------------------------------------------------------------
// Tray icon + status menu.
// ---------------------------------------------------------------------------
function setStatus(state, detail) {
  status.state = state;
  if (detail !== undefined) status.detail = detail;
  updateTray();
}

function statusLine() {
  switch (status.state) {
    case "streaming":
      return `\u25CF Streaming \u2013 ${config.ndiName}${
        status.size ? " @ " + status.size : ""
      }`;
    case "loading":
      return "\u25CB Loading page\u2026";
    case "error":
      return `\u26A0 Error: ${status.detail || "see log"}`;
    default:
      return "\u25CB Starting\u2026";
  }
}

function openConfig() {
  if (config.configPath) {
    shell.openPath(config.configPath).then((err) => {
      if (err) console.error("[tray] open config failed:", err);
    });
  }
}

function updateTray() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: statusLine(), enabled: false },
    { label: `URL: ${config.url}`, enabled: false },
    { type: "separator" },
    { label: "Open config.json", click: openConfig },
    {
      label: "Open log file",
      click: () => shell.openPath(logger.getLogFilePath()),
    },
    {
      label: "Open log folder",
      click: () => shell.showItemInFolder(logger.getLogFilePath()),
    },
    { type: "separator" },
    {
      label: "Reload page",
      click: () => {
        if (win && !win.isDestroyed()) {
          setStatus("loading");
          win.loadURL(config.url).catch((e) => scheduleReload(e.message));
        }
      },
    },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setToolTip(`HTML to NDI \u2013 ${statusLine()}`);
  tray.setContextMenu(menu);
}

function createTray() {
  const icon = nativeImage.createFromBuffer(
    Buffer.from(TRAY_ICON_BASE64, "base64"),
  );
  tray = new Tray(icon);
  updateTray();
}

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
  status.size = `${width}x${height}`;
  setStatus("streaming");
  console.log(`[ndi] Source "${config.ndiName}" @ ${width}x${height}`);
}

function scheduleReload(reason) {
  setStatus("error", reason);
  if (reloadTimer) return;
  const secs = Math.max(1, config.reloadOnFailureSeconds || 5);
  console.warn(`[reload] ${reason} - retrying in ${secs}s`);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    if (win && !win.isDestroyed()) {
      setStatus("loading");
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

  win.webContents.on("did-finish-load", () => {
    console.log("[load] page loaded");
    // Stay in 'loading' until the first frame actually creates the sender;
    // ensureSender() flips status to 'streaming'.
    if (status.state === "error") setStatus("loading");
  });

  setStatus("loading");
  win.loadURL(config.url).catch((e) => scheduleReload(e.message));
}

app.whenReady().then(() => {
  console.log(
    `[start] URL=${config.url} size=${config.width}x${config.height} ` +
      `fps=${config.fps} transparent=${config.transparent}`,
  );
  console.log(`[start] log file: ${logger.getLogFilePath()}`);
  console.log(`[start] config file: ${config.configPath}`);
  createTray();
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
