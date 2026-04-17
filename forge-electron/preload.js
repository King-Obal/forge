const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe API bridge to the renderer (no direct Node access)
contextBridge.exposeInMainWorld('forgeApi', {
  get:    (endpoint)       => ipcRenderer.invoke('api:get',    endpoint),
  post:   (endpoint, body) => ipcRenderer.invoke('api:post',   endpoint, body),
  delete: (endpoint)       => ipcRenderer.invoke('api:delete', endpoint),
  importMoxfield:     (url)       => ipcRenderer.invoke('api:import-moxfield', url),
  importMoxfieldPlay: (url, name) => ipcRenderer.invoke('api:import-moxfield', url, name)
});
