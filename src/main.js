// Web2NDI - Electron main process
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
  ipcMain,
} = require("electron");
const path = require("path");
const fs = require("fs");
const logger = require("./logger");

// Single instance: a second launch must not fight over the NDI name.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Start file logging before anything else so early failures are captured.
logger.init();
logger.patchConsole();

const {
  loadConfig,
  loadRawConfig,
  writeConfig,
  resolveConfigPath,
} = require("./config");

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------
let tray = null;

// Tray icon (32px PNG, base64) generated from build/icon.svg, embedded so the
// packaged app needs no external asset. Regenerate with scripts/make-icons.js.
const TRAY_ICON_BASE64 = require("./tray-icon");

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

// Load the initial configuration. Parsing happens before app "ready" because
// disableHardwareAcceleration must be decided that early. A broken config at
// startup leaves the app running with no streams; the file watcher recovers as
// soon as the file is fixed.
let appConfig;
try {
  appConfig = loadConfig();
} catch (err) {
  console.error(`[config] Failed to parse config at startup: ${err.message}`);
  appConfig = {
    configPath: resolveConfigPath(),
    disableHardwareAcceleration: true,
    streams: [],
  };
}

// disableHardwareAcceleration can only be applied once, before "ready". A later
// change in the config file therefore requires an app restart (we warn on it).
const initialDisableHWA = appConfig.disableHardwareAcceleration;

// Software offscreen rendering yields CPU-accessible BGRA bitmaps in the
// "paint" event, which is exactly what NDI needs. GPU OSR delivers a shared
// texture instead, so disabling HW acceleration keeps things simple/robust.
if (initialDisableHWA) {
  app.disableHardwareAcceleration();
}

// Keep producing frames even when the window is hidden / not focused.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// Active streams (one Stream instance per configured NDI source) and the
// debounce/watch state used to live-reload config.json.
let streams = [];
let configError = null; // last config-parse error message, surfaced in the tray
let watchedPath = null;
let reloadDebounce = null;
let logWin = null; // the live log viewer window, if open
let configWin = null; // the config editor window, if open

// ---------------------------------------------------------------------------
// Stream: owns one offscreen window + NDI sender pair plus the timers that keep
// the source alive. Each configured NDI source gets its own instance.
// ---------------------------------------------------------------------------
class Stream {
  constructor(cfg) {
    this.cfg = cfg;
    this.win = null;
    this.sender = null;
    this.senderW = 0;
    this.senderH = 0;
    // Latest captured frame. Chromium's offscreen renderer only fires "paint"
    // when the page changes, so we cache the most recent bitmap and re-transmit
    // it on a steady timer. This keeps the NDI stream alive and guarantees a
    // receiver connecting at any moment immediately gets the current frame.
    this.lastFrame = null; // { data: Buffer, width, height }
    this.frameTimer = null;
    this.healthTimer = null;
    this.reloadTimer = null;
    this.sendCount = 0;
    this.state = "starting"; // starting | loading | streaming | error
    this.detail = "";
    this.size = "";
    this.destroyed = false;
  }

  setStatus(state, detail) {
    this.state = state;
    if (detail !== undefined) this.detail = detail;
    updateTray();
  }

  statusLine() {
    switch (this.state) {
      case "streaming":
        return `\u25CF ${this.cfg.ndiName}${this.size ? " @ " + this.size : ""}`;
      case "loading":
        return `\u25CB ${this.cfg.ndiName} \u2013 loading\u2026`;
      case "error":
        return `\u26A0 ${this.cfg.ndiName} \u2013 ${this.detail || "see log"}`;
      default:
        return `\u25CB ${this.cfg.ndiName} \u2013 starting\u2026`;
    }
  }

  ensureSender(width, height) {
    if (this.sender && width === this.senderW && height === this.senderH) {
      return;
    }
    if (this.sender) {
      try {
        this.sender.destroy();
      } catch (e) {
        /* ignore */
      }
      this.sender = null;
    }
    this.sender = new addon.NdiSender(this.cfg.ndiName);
    this.senderW = width;
    this.senderH = height;
    this.size = `${width}x${height}`;
    this.setStatus("streaming");
    console.log(`[ndi] Source "${this.cfg.ndiName}" @ ${width}x${height}`);
  }

  // Transmit the most recent frame at a steady cadence (cfg.fps). Sending
  // continuously - rather than only on the 'paint' event - means a receiver
  // that selects the source at any time immediately receives the current frame,
  // instead of a stale one left over from the last page change.
  startFrameLoop() {
    if (this.frameTimer) return;
    const intervalMs = Math.max(
      1,
      Math.round(1000 / Math.max(1, this.cfg.fps)),
    );
    console.log(
      `[frame] "${this.cfg.ndiName}" loop started: target ${this.cfg.fps} fps (every ${intervalMs}ms)`,
    );
    this.frameTimer = setInterval(() => {
      if (!this.lastFrame) return;
      try {
        this.ensureSender(this.lastFrame.width, this.lastFrame.height);
        this.sender.send(
          this.lastFrame.data,
          this.lastFrame.width,
          this.lastFrame.height,
          this.cfg.frameRateNumerator,
          this.cfg.frameRateDenominator,
        );
        this.sendCount++;
      } catch (err) {
        console.error(`[frame] "${this.cfg.ndiName}"`, err.message);
      }
    }, intervalMs);
    this.startHealthLoop();
  }

  // Periodic health line so the log shows, at a glance, that frames are still
  // flowing to NDI and how many receivers are connected. A drop to 0 fps points
  // to a stalled renderer; 0 receivers with frames flowing points to a network
  // or discovery problem on the receiving side.
  startHealthLoop() {
    if (this.healthTimer) return;
    const windowSecs = 10;
    this.healthTimer = setInterval(() => {
      const fps = Math.round(this.sendCount / windowSecs);
      this.sendCount = 0;
      if (fps === 0) {
        console.warn(
          `[health] "${this.cfg.ndiName}" no frames sent in last ${windowSecs}s ` +
            `(lastFrame=${this.lastFrame ? "present" : "none"})`,
        );
        return;
      }
      const receivers =
        this.sender && typeof this.sender.getConnections === "function"
          ? this.sender.getConnections()
          : "?";
      console.log(
        `[health] "${this.cfg.ndiName}" ${fps} fps to NDI, receivers=${receivers}, ${this.senderW}x${this.senderH}`,
      );
    }, windowSecs * 1000);
  }

  stopLoops() {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  scheduleReload(reason) {
    this.setStatus("error", reason);
    if (this.reloadTimer || this.destroyed) return;
    const secs = Math.max(1, this.cfg.reloadOnFailureSeconds || 5);
    console.warn(
      `[reload] "${this.cfg.ndiName}" ${reason} - retrying in ${secs}s`,
    );
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      if (this.win && !this.win.isDestroyed()) {
        this.setStatus("loading");
        this.win
          .loadURL(this.cfg.url)
          .catch((e) => this.scheduleReload(e.message));
      }
    }, secs * 1000);
  }

  start() {
    const cfg = this.cfg;
    this.win = new BrowserWindow({
      width: cfg.width,
      height: cfg.height,
      show: false,
      frame: false,
      transparent: cfg.transparent,
      backgroundColor: cfg.transparent ? "#00000000" : "#000000",
      useContentSize: true,
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    this.win.webContents.setAudioMuted(true);
    this.win.webContents.setFrameRate(cfg.fps);

    this.win.webContents.on("paint", (event, dirty, image) => {
      try {
        const sz = image.getSize();
        if (sz.width === 0 || sz.height === 0) return;
        // Copy the bitmap: the image buffer is only valid for the duration of
        // the event, but the frame loop needs a stable reference between paints.
        this.lastFrame = {
          data: Buffer.from(image.toBitmap()), // BGRA, length = w*h*4
          width: sz.width,
          height: sz.height,
        };
      } catch (err) {
        console.error(`[paint] "${cfg.ndiName}"`, err.message);
      }
    });

    this.startFrameLoop();

    this.win.webContents.on(
      "did-fail-load",
      (e, code, desc, url, isMainFrame) => {
        if (isMainFrame) this.scheduleReload(`did-fail-load (${code} ${desc})`);
      },
    );

    this.win.webContents.on("render-process-gone", (e, details) => {
      this.scheduleReload(`render-process-gone (${details.reason})`);
    });

    this.win.webContents.on("unresponsive", () => {
      this.scheduleReload("renderer unresponsive");
    });

    this.win.webContents.on("did-finish-load", () => {
      console.log(`[load] "${cfg.ndiName}" page loaded`);
      // Stay in 'loading' until the first frame actually creates the sender;
      // ensureSender() flips status to 'streaming'.
      if (this.state === "error") this.setStatus("loading");
    });

    this.setStatus("loading");
    this.win.loadURL(cfg.url).catch((e) => this.scheduleReload(e.message));
  }

  destroy() {
    this.destroyed = true;
    this.stopLoops();
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.win && !this.win.isDestroyed()) {
      try {
        this.win.destroy();
      } catch (e) {
        /* ignore */
      }
    }
    this.win = null;
    if (this.sender) {
      try {
        this.sender.destroy();
      } catch (e) {
        /* ignore */
      }
      this.sender = null;
    }
    this.lastFrame = null;
  }
}

// ---------------------------------------------------------------------------
// Tray icon + status menu.
// ---------------------------------------------------------------------------

// Editable GUI for config.json. The renderer never touches the file directly;
// it talks to the main process over IPC (config:load / config:save), which owns
// all file access. Saving writes the canonical config and the existing file
// watcher live-reloads the running streams.
function openConfigEditor() {
  if (configWin && !configWin.isDestroyed()) {
    if (configWin.isMinimized()) configWin.restore();
    configWin.show();
    configWin.focus();
    return;
  }

  configWin = new BrowserWindow({
    width: 820,
    height: 720,
    title: "Web2NDI \u2013 Configuration",
    backgroundColor: "#1e1e1e",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "config-editor-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  configWin.setMenuBarVisibility(false);

  configWin.on("closed", () => {
    configWin = null;
  });

  configWin.loadFile(path.join(__dirname, "config-editor.html"));
}

// IPC backing the config editor. Registered once at startup.
function registerConfigIpc() {
  ipcMain.handle("config:load", () => {
    try {
      return loadRawConfig();
    } catch (err) {
      // Surface a parse error so the editor can offer a clean start instead of
      // silently overwriting a file the user may still want to fix by hand.
      return {
        error: err.message,
        configPath: resolveConfigPath(),
        builtInDefaults: require("./config").STREAM_DEFAULTS,
      };
    }
  });

  ipcMain.handle("config:save", (_e, model) => {
    try {
      if (!model || !Array.isArray(model.streams) || model.streams.length === 0) {
        return { ok: false, error: "At least one stream is required." };
      }
      for (const s of model.streams) {
        if (!s || !String(s.url || "").trim()) {
          return { ok: false, error: "Every stream needs a URL." };
        }
        if (!String(s.ndiName || "").trim()) {
          return { ok: false, error: "Every stream needs an NDI name." };
        }
      }
      const target = writeConfig(model);
      console.log(`[config] saved from editor: ${target}`);
      return { ok: true, path: target };
    } catch (err) {
      console.error("[config] save failed:", err);
      return { ok: false, error: err.message };
    }
  });
}

// Autostart is managed through Electron's login-item API, which on Windows
// writes a per-user registry Run entry pointing at this executable. No external
// script or admin rights are required.
function isAutoStartEnabled() {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch (e) {
    return false;
  }
}

function setAutoStart(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled });
    console.log(`[autostart] ${enabled ? "enabled" : "disabled"}`);
  } catch (e) {
    console.error("[autostart]", e.message);
  }
  updateTray();
}

// Open (or focus) a live log viewer window. It shows the buffered session log
// on open and then streams new lines as they are written.
function openLogViewer() {
  if (logWin && !logWin.isDestroyed()) {
    if (logWin.isMinimized()) logWin.restore();
    logWin.show();
    logWin.focus();
    return;
  }

  logWin = new BrowserWindow({
    width: 960,
    height: 600,
    title: "Web2NDI \u2013 Log",
    backgroundColor: "#1e1e1e",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "log-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  logWin.setMenuBarVisibility(false);

  const wc = logWin.webContents;
  const onLine = (line) => {
    if (logWin && !logWin.isDestroyed()) wc.send("log:line", line);
  };

  wc.on("did-finish-load", () => {
    wc.send("log:init", logger.getBuffer());
    logger.events.on("line", onLine);
  });

  logWin.on("closed", () => {
    logger.events.removeListener("line", onLine);
    logWin = null;
  });

  logWin.loadFile(path.join(__dirname, "log-viewer.html"));
}

function traySummary() {
  if (configError) return `\u26A0 Config error`;
  if (streams.length === 0) return "No streams configured";
  const streaming = streams.filter((s) => s.state === "streaming").length;
  return `${streaming}/${streams.length} streaming`;
}

function updateTray() {
  if (!tray) return;
  const items = [];
  if (configError) {
    items.push({
      label: `\u26A0 Config error \u2013 ${configError}`,
      enabled: false,
    });
    items.push({ type: "separator" });
  } else if (streams.length === 0) {
    items.push({ label: "No streams configured", enabled: false });
    items.push({ type: "separator" });
  }
  streams.forEach((s) => {
    items.push({ label: s.statusLine(), enabled: false });
    items.push({ label: `    ${s.cfg.url}`, enabled: false });
  });
  if (streams.length > 0) items.push({ type: "separator" });
  items.push({ label: "Edit configuration\u2026", click: openConfigEditor });
  items.push({ label: "Open log viewer", click: openLogViewer });
  items.push({ type: "separator" });
  items.push({
    label: "Start automatically at logon",
    type: "checkbox",
    checked: isAutoStartEnabled(),
    click: (item) => {
      setAutoStart(item.checked);
      // Windows tray menus dismiss on any click, which feels wrong for a
      // toggle. Re-open the (rebuilt) menu so flipping this switch keeps the
      // menu visible instead of closing it.
      if (tray) setTimeout(() => tray.popUpContextMenu(), 0);
    },
  });
  items.push({ label: "Quit", click: () => app.quit() });

  tray.setToolTip(`Web2NDI \u2013 ${traySummary()}`);
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  const icon = nativeImage.createFromBuffer(
    Buffer.from(TRAY_ICON_BASE64, "base64"),
  );
  tray = new Tray(icon);
  updateTray();
}

// ---------------------------------------------------------------------------
// Stream lifecycle + live config reload.
// ---------------------------------------------------------------------------
function startStreams(cfg) {
  streams = cfg.streams.map((sc) => {
    const s = new Stream(sc);
    s.start();
    return s;
  });
  updateTray();
}

function stopStreams() {
  for (const s of streams) s.destroy();
  streams = [];
}

// Re-read config.json and rebuild all streams. On a parse error we keep the
// currently running streams and surface the problem in the tray/log, so a
// half-saved or invalid edit never takes the running service down.
function reloadConfig() {
  let next;
  try {
    next = loadConfig();
  } catch (err) {
    configError = err.message;
    console.warn(
      `[config] reload failed, keeping current streams: ${err.message}`,
    );
    updateTray();
    return;
  }
  configError = null;

  if (next.disableHardwareAcceleration !== initialDisableHWA) {
    console.warn(
      "[config] disableHardwareAcceleration changed; restart the app for it to take effect.",
    );
  }

  console.log(`[config] reloaded: ${next.streams.length} stream(s)`);
  appConfig = next;
  stopStreams();
  startStreams(next);
}

// Watch the config file and live-reload on change. fs.watchFile (polling) is
// used because it reliably handles editors that save atomically (write temp +
// rename) and files that appear/disappear, which fs.watch can miss.
function startConfigWatch() {
  watchedPath = appConfig.configPath;
  if (!watchedPath) {
    console.warn("[config] no config path to watch");
    return;
  }
  console.log(`[config] watching ${watchedPath}`);
  fs.watchFile(watchedPath, { interval: 1000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    // Debounce: editors can write in several steps.
    if (reloadDebounce) clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(() => {
      reloadDebounce = null;
      console.log("[config] change detected, reloading");
      reloadConfig();
    }, 300);
  });
}

app.whenReady().then(() => {
  console.log(
    `[start] Web2NDI v${app.getVersion()} (electron ${process.versions.electron})`,
  );
  console.log(
    `[start] ${appConfig.streams.length} stream(s), ` +
      `disableHardwareAcceleration=${initialDisableHWA}`,
  );
  appConfig.streams.forEach((s) =>
    console.log(
      `[start]   - "${s.ndiName}" ${s.url} ${s.width}x${s.height}@${s.fps}`,
    ),
  );
  console.log(`[start] log file: ${logger.getLogFilePath()}`);
  console.log(`[start] config file: ${appConfig.configPath}`);
  if (configError) console.warn(`[start] config error: ${configError}`);
  registerConfigIpc();
  createTray();
  startStreams(appConfig);
  startConfigWatch();
});

// Tray app: stay alive even if all offscreen windows momentarily close during a
// config reload. Quitting is driven explicitly by the tray "Quit" item.
app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  if (watchedPath) {
    try {
      fs.unwatchFile(watchedPath);
    } catch (e) {
      /* ignore */
    }
  }
  stopStreams();
});
