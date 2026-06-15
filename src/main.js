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

// Latest captured frame. Chromium's offscreen renderer only fires "paint" when
// the page changes, so we cache the most recent bitmap and re-transmit it on a
// steady timer. This keeps the NDI stream alive and guarantees that a receiver
// connecting at any moment immediately gets the current frame instead of
// whatever happened to be sent last.
let lastFrame = null; // { data: Buffer, width, height }
let frameTimer = null;

// Diagnostic counters (reset every stats window).
let paintCount = 0;
let sendCount = 0;
let statsTimer = null;

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

// Transmit the most recent frame at a steady cadence (config.fps). Sending
// continuously - rather than only on the 'paint' event - means a receiver that
// selects the source at any time immediately receives the current frame,
// instead of a stale one left over from the last page change.
function startFrameLoop() {
  if (frameTimer) return;
  const intervalMs = Math.max(1, Math.round(1000 / Math.max(1, config.fps)));
  console.log(
    `[frame] loop started: target ${config.fps} fps (every ${intervalMs}ms)`,
  );
  frameTimer = setInterval(() => {
    if (!lastFrame) return;
    try {
      ensureSender(lastFrame.width, lastFrame.height);
      sender.send(
        lastFrame.data,
        lastFrame.width,
        lastFrame.height,
        config.frameRateNumerator,
        config.frameRateDenominator,
      );
      sendCount++;
    } catch (err) {
      console.error("[frame]", err.message);
    }
  }, intervalMs);
  startStatsLoop();
}

// Once per second, report how many frames were painted by Chromium vs. how many
// were actually transmitted to NDI. Steady ~config.fps sends with occasional
// paints is the healthy pattern.
function startStatsLoop() {
  if (statsTimer) return;
  statsTimer = setInterval(() => {
    const connections =
      sender && typeof sender.getConnections === "function"
        ? sender.getConnections()
        : "n/a";
    console.log(
      `[stats] paints=${paintCount}/s sends=${sendCount}/s ` +
        `size=${senderW}x${senderH} receivers=${connections} ` +
        `lastFrame=${lastFrame ? "yes" : "none"} ${sampleContent(lastFrame)}`,
    );
    paintCount = 0;
    sendCount = 0;
  }, 1000);
}

// Inspect the pixel content of a captured BGRA frame so the log reveals whether
// the renderer is producing real content or just a uniform/black image.
function sampleContent(frame) {
  if (!frame || !frame.data || frame.data.length < 4) return "content=?";
  const buf = frame.data; // BGRA
  const w = frame.width;
  const h = frame.height;
  const stride = w * 4;
  let rMin = 255,
    rMax = 0,
    gMin = 255,
    gMax = 0,
    bMin = 255,
    bMax = 0;
  const stepX = w > 64 ? Math.floor(w / 64) : 1;
  const stepY = h > 64 ? Math.floor(h / 64) : 1;
  for (let y = 0; y < h; y += stepY) {
    const rowOff = y * stride;
    for (let x = 0; x < w; x += stepX) {
      const o = rowOff + x * 4;
      const b = buf[o];
      const g = buf[o + 1];
      const r = buf[o + 2];
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
      if (g < gMin) gMin = g;
      if (g > gMax) gMax = g;
      if (b < bMin) bMin = b;
      if (b > bMax) bMax = b;
    }
  }
  const uniform = rMin === rMax && gMin === gMax && bMin === bMax;
  let verdict;
  if (uniform) {
    verdict = rMax === 0 ? "BLACK" : `UNIFORM(${rMax},${gMax},${bMax})`;
  } else {
    verdict = "CONTENT";
  }
  return `content=${verdict} R[${rMin}-${rMax}] G[${gMin}-${gMax}] B[${bMin}-${bMax}]`;
}

function stopFrameLoop() {
  if (frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
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
      // Copy the bitmap: the image buffer is only valid for the duration of the
      // event, but the frame loop needs a stable reference between paints.
      lastFrame = {
        data: Buffer.from(image.toBitmap()), // BGRA, length = w*h*4
        width: size.width,
        height: size.height,
      };
      paintCount++;
    } catch (err) {
      console.error("[paint]", err.message);
    }
  });

  startFrameLoop();

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
    `[start] HTML to NDI Converter v${app.getVersion()} (electron ${process.versions.electron})`,
  );
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
  stopFrameLoop();
  if (sender) {
    try {
      sender.destroy();
    } catch (e) {
      /* ignore */
    }
    sender = null;
  }
});
