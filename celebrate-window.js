// The small pop-up card (celebrate.html) shown when a milestone is reached and
// no extension page is open: plays the animation named in its address behind a
// one-line message, then closes itself after the chosen number of seconds
// (settings.celebrationSeconds, 3 by default). A click or Esc closes it early.
(() => {
  const p = new URLSearchParams(location.search);
  const mood = p.get("mood") === "sad" ? "sad" : "happy";
  const big = p.get("big") === "1";
  const secs = Math.max(1, Math.min(15, Number(p.get("secs")) || 3));
  document.getElementById("t").textContent = p.get("title") || (mood === "sad" ? "Not quite there today" : "Milestone reached! \ud83c\udf89");
  document.getElementById("s").textContent = p.get("sub") || "";
  if (mood === "sad") {
    document.body.style.background = "#2c3448";
    document.title = "Not quite there today";
  }
  // Let the window finish sizing before drawing.
  setTimeout(() => { if (window.pcmCelebrate) window.pcmCelebrate({ mood, big, secs, right: true }); }, 120);
  const bye = () => { try { window.close(); } catch (e) {} };
  setTimeout(bye, secs * 1000 + 250);
  document.addEventListener("click", bye);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") bye(); });
})();
