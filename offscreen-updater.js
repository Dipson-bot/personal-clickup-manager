// Automatic background updates. The service worker can't write to the
// extension's folder, so it asks this offscreen page to do it, using the folder
// handle the user chose once on the update page. This page never ASKS for
// permission (there's nobody to click): it only proceeds when Chrome already
// allows it ("Allow on every visit"), and otherwise reports back so the normal
// "update available" notice is shown instead.
import { kvGet, isRunningFolder, installPackage } from "./lib-updater.js";

let running = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen" || msg.type !== "AUTO_UPDATE") return;
  if (running) { sendResponse({ ok: false, reason: "busy" }); return; }
  running = true;
  (async () => {
    try {
      const ui = msg.ui || {};
      if (!ui.zip || !ui.latest) return { ok: false, reason: "no-update" };
      const root = await kvGet("extDir").catch(() => null);
      if (!root) return { ok: false, reason: "no-folder" };
      if ((await root.queryPermission({ mode: "readwrite" })) !== "granted") return { ok: false, reason: "permission" };
      if (!(await isRunningFolder(root))) return { ok: false, reason: "moved" };
      const r = await installPackage(root, ui, chrome.runtime.getManifest());
      return { ok: true, version: r.version };
    } catch (e) {
      return { ok: false, reason: "failed", error: String(e && e.message ? e.message : e) };
    }
  })().then((r) => {
    running = false;
    try { sendResponse(r); } catch (e) {}
  });
  return true; // answer asynchronously
});
