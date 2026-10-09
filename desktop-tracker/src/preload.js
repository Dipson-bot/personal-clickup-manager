// The only bridge between the tracker window and the app: a handful of calls,
// no Node.js and no ClickUp token in the window.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tracker", {
  state: () => ipcRenderer.invoke("state"),
  settings: () => ipcRenderer.invoke("settings"),
  setup: (token) => ipcRenderer.invoke("setup", token),
  action: (a) => ipcRenderer.invoke("action", a),
  expand: (on) => ipcRenderer.invoke("expand", on),
  hover: (on) => ipcRenderer.invoke("hover", on),
  open: (url) => ipcRenderer.invoke("open", url),
  comments: (force) => ipcRenderer.invoke("comments", force),
  seen: (taskId) => ipcRenderer.invoke("seen", taskId),
  menu: () => ipcRenderer.invoke("menu"),
  peek: (on) => ipcRenderer.invoke("peek", on),
  on: (ch, cb) => {
    if (!["state", "comments", "settings", "update", "pointer", "big", "error"].includes(ch)) return;
    ipcRenderer.on(ch, (e, v) => cb(v));
  },
});
