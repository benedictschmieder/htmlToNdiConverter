// Preload for the configuration editor window. Bridges the (context-isolated)
// renderer to the main process via a minimal, safe API. All file access stays
// in the main process; the renderer only ever sends/receives plain data.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("configApi", {
  // Read the current config split into app option / global defaults / streams.
  load: () => ipcRenderer.invoke("config:load"),
  // Persist the edited model. Resolves to { ok, path } or { ok:false, error }.
  save: (model) => ipcRenderer.invoke("config:save", model),
});
