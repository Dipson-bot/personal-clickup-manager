// Automatic update from a background tab. The hidden offscreen page can't always
// use the folder permission ("Allow on every visit" is applied to the
// extension's own tabs; the offscreen page then reads "prompt" and the install
// stops). So when that happens the background opens THIS page in a tab that is
// not focused (the tab you're working in stays in front), it installs with the
// same code as the update page, reports back, and the background closes it and
// reloads the extension. It never asks for anything: no permission, no
// install - it just reports why.
import { kvGet, isRunningFolder, installPackage } from "./lib-updater.js";

const nonce = new URLSearchParams(location.search).get("n") || "";
const $ = (id) => document.getElementById(id);

async function run() {
  const { updateInfo: ui } = await chrome.storage.local.get("updateInfo");
  if (!ui || !ui.zip || !ui.latest) return { ok: false, reason: "no-update" };
  $("t").textContent = "Installing v" + ui.latest + "…";
  const root = await kvGet("extDir").catch(() => null);
  if (!root) return { ok: false, reason: "no-folder" };
  if ((await root.queryPermission({ mode: "readwrite" })) !== "granted") return { ok: false, reason: "permission" };
  if (!(await isRunningFolder(root))) return { ok: false, reason: "moved" };
  const r = await installPackage(root, { latest: ui.latest, zip: ui.zip }, chrome.runtime.getManifest());
  return { ok: true, version: r.version };
}

run()
  .catch((e) => ({ ok: false, reason: "failed", error: String(e && e.message ? e.message : e) }))
  .then((r) => {
    $("t").textContent = r.ok ? "Updated to v" + r.version + " ✓" : "Couldn't install the update here";
    $("s").textContent = r.ok ? "The extension restarts now; this tab closes by itself." : "This tab closes by itself. You'll get a notice with what to do.";
    chrome.runtime.sendMessage({ type: "AUTO_UPDATE_TAB_RESULT", nonce, ...r }).catch(() => {});
  });
