// offscreen.js
// -----------------------------------------------------------------------------
// Runs inside offscreen.html (an AUDIO_PLAYBACK offscreen document). The MV3
// service worker cannot play audio itself, so it sends { type: "PLAY_SOUND" }
// here and we play the bundled clips. Autoplay is permitted for offscreen
// documents created with the AUDIO_PLAYBACK reason, so no user gesture needed.
//
// We reply with { ok: true } so the service worker knows the message was
// received. Right after chrome.offscreen.createDocument() resolves, this page's
// listener may not be wired for an instant; the worker retries the send until it
// gets this ack.
// -----------------------------------------------------------------------------

// Clips are played through a small FIFO queue so EVERY distinct notification is
// audible. Two notifications can fire in the same refresh cycle (e.g. the
// under-target nudge + the end-of-day warning are both "danger") - the old
// time-based same-clip guard swallowed the second one. Now each logical play is
// tagged with a `nonce` from the worker: retries of a lost ack reuse the same
// nonce (deduped, never stutter), while a genuinely new notification gets its
// own entry and its sound plays after the current clip finishes.
let lastNonce = "";
const q = [];
let draining = false;

const clipFor = (sound) =>
  sound === "danger" ? "danger" : sound === "winner" ? "winner" : "chime";

function drainQueue() {
  if (draining) return;
  draining = true;
  const playNext = () => {
    const id = q.shift();
    if (!id) { draining = false; return; }
    const el = document.getElementById(id) || document.getElementById("chime");
    try {
      if (el) {
        el.currentTime = 0;
        const p = el.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    } catch (e) {
      // Nothing actionable if playback is blocked - stay silent.
    }
    // Small gap before the next queued clip so sequential sounds stay distinct.
    setTimeout(playNext, 200);
  };
  playNext();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen" || msg.type !== "PLAY_SOUND") return;
  if (!msg.nonce || msg.nonce === lastNonce) {
    // Worker retry of a logical play we've already queued - don't double it.
  } else {
    lastNonce = msg.nonce;
    q.push(clipFor(msg.sound));
    drainQueue();
  }
  // Always acknowledge so the worker stops retrying.
  try { sendResponse({ ok: true }); } catch (e) {}
  return true;
});