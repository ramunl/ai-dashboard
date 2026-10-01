// Loaded before every other script: shows script errors on the page, even
// when a later file fails to load or run, so the page never sits silently.
(function () {
  const START_TIMEOUT_MS = 4000;

  function report(message) {
    const box = document.getElementById("alert");
    if (!box) return;
    box.textContent = (box.textContent ? box.textContent + "\n" : "") + message;
    box.hidden = false;
  }

  window.addEventListener("error", function (event) {
    const target = event.target;
    if (target && target.tagName === "SCRIPT") {
      report("Script failed to load: " + target.src);
      return;
    }
    const where = event.filename ? " (" + event.filename.split("/").pop() + ":" + event.lineno + ")" : "";
    report("Page error: " + event.message + where);
  }, true);

  window.addEventListener("unhandledrejection", function (event) {
    const reason = event.reason;
    report("Page error: " + (reason && reason.message ? reason.message : String(reason)));
  });

  // app.js sets window.dashboardStarted once it has run.
  setTimeout(function () {
    if (!window.dashboardStarted) report("The page scripts did not start (" + navigator.userAgent + ")");
  }, START_TIMEOUT_MS);
})();
