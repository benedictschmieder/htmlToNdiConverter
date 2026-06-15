// Loads configuration from config.json with sensible defaults.
//
// Resolution order for the config file:
//   1. The HTML2NDI_CONFIG environment variable (absolute path), if set.
//   2. config.json next to the packaged executable (process.resourcesPath/..).
//   3. config.json in the project root (development).
//
// The file may describe a single stream or several. All of the following are
// accepted:
//
//   // 1) Single stream (legacy/flat form)
//   { "url": "...", "ndiName": "...", ... }
//
//   // 2) Multiple streams under a "streams" array. Keys outside the array act
//   //    as shared defaults for every stream, plus app-level options.
//   { "disableHardwareAcceleration": true,
//     "streams": [ { "url": "...", "ndiName": "A" }, { "url": "...", "ndiName": "B" } ] }
//
//   // 3) A top-level array of stream objects.
//   [ { "url": "...", "ndiName": "A" }, { "url": "...", "ndiName": "B" } ]

const fs = require("fs");
const path = require("path");

// Per-stream options (each NDI source gets its own values).
const STREAM_DEFAULTS = {
  url: "https://example.com",
  ndiName: "HTML to NDI",
  width: 1920,
  height: 1080,
  fps: 60,
  frameRateNumerator: 60000,
  frameRateDenominator: 1000,
  transparent: false,
  reloadOnFailureSeconds: 5,
};

// App-level options (apply to the whole process, not a single stream).
const APP_DEFAULTS = {
  disableHardwareAcceleration: true,
};

function candidatePaths() {
  const paths = [];
  if (process.env.HTML2NDI_CONFIG) {
    paths.push(process.env.HTML2NDI_CONFIG);
  }
  // Packaged: config.json sits next to the .exe (extraResources -> ../config.json).
  if (process.resourcesPath) {
    paths.push(path.join(process.resourcesPath, "..", "config.json"));
    paths.push(path.join(process.resourcesPath, "config.json"));
  }
  // Development: project root.
  paths.push(path.join(__dirname, "..", "config.json"));
  return paths;
}

// Resolve the config file we should read/watch: the first candidate that
// exists, or the most likely place one should live (next to the packaged exe).
function resolveConfigPath() {
  const candidates = candidatePaths();
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return candidates[candidates.length - 1] || null;
}

function sanitizeStream(raw) {
  const s = { ...STREAM_DEFAULTS, ...raw };
  s.width = Math.max(2, Math.round(Number(s.width) || STREAM_DEFAULTS.width));
  s.height = Math.max(
    2,
    Math.round(Number(s.height) || STREAM_DEFAULTS.height),
  );
  s.fps = Math.min(
    60,
    Math.max(1, Math.round(Number(s.fps) || STREAM_DEFAULTS.fps)),
  );
  s.frameRateNumerator =
    Math.round(Number(s.frameRateNumerator)) ||
    STREAM_DEFAULTS.frameRateNumerator;
  s.frameRateDenominator =
    Math.round(Number(s.frameRateDenominator)) ||
    STREAM_DEFAULTS.frameRateDenominator;
  s.transparent = !!s.transparent;
  s.reloadOnFailureSeconds = Math.max(
    1,
    Math.round(Number(s.reloadOnFailureSeconds) || 5),
  );
  s.url = String(s.url);
  s.ndiName = String(s.ndiName);
  return s;
}

// NDI source names must be unique on the network; suffix any duplicates.
function ensureUniqueNames(streams) {
  const counts = new Map();
  for (const s of streams) {
    const base = s.ndiName;
    if (counts.has(base)) {
      const n = counts.get(base) + 1;
      counts.set(base, n);
      const unique = `${base} ${n}`;
      console.warn(`[config] Duplicate NDI name "${base}" -> "${unique}"`);
      s.ndiName = unique;
    } else {
      counts.set(base, 1);
    }
  }
  return streams;
}

// Read and parse the config file. Throws on JSON parse errors so callers can
// decide whether to keep the previous good config (used on live reload).
function loadConfig() {
  const configPath = resolveConfigPath();
  let raw = {};
  if (configPath && fs.existsSync(configPath)) {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }

  // Split the parsed file into app-level options and the list of stream objects.
  let appOptions;
  let rawStreams;
  if (Array.isArray(raw)) {
    appOptions = {};
    rawStreams = raw;
  } else if (raw && Array.isArray(raw.streams)) {
    const { streams, ...rest } = raw;
    appOptions = rest;
    rawStreams = streams;
  } else {
    // Flat single-stream object: it can also carry app-level keys.
    appOptions = raw || {};
    rawStreams = [raw || {}];
  }

  // Top-level per-stream keys act as shared defaults for every stream.
  const sharedDefaults = {};
  for (const key of Object.keys(STREAM_DEFAULTS)) {
    if (appOptions[key] !== undefined) sharedDefaults[key] = appOptions[key];
  }

  let streams = rawStreams
    .filter((s) => s && typeof s === "object" && !Array.isArray(s))
    .map((s) => sanitizeStream({ ...sharedDefaults, ...s }));

  if (streams.length === 0) {
    streams = [sanitizeStream({ ...sharedDefaults })];
  }

  ensureUniqueNames(streams);

  const disableHardwareAcceleration =
    appOptions.disableHardwareAcceleration !== undefined
      ? !!appOptions.disableHardwareAcceleration
      : APP_DEFAULTS.disableHardwareAcceleration;

  return { configPath, disableHardwareAcceleration, streams };
}

module.exports = { loadConfig, resolveConfigPath };
