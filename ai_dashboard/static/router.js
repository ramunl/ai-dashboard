  // path -> [api window, renderer]
  const PAGES = { "": ["launcher", renderLauncher], coding: ["coding", codingPage],
                  pm: ["pm", pmPage], ops: ["launcher", renderOps] };

  function currentPath() {
    const path = location.pathname.replace(/^\/+|\/+$/g, "");
    return PAGES[path] ? path : "";
  }

  const TITLES = { "": "AI Agents", ops: "Ops agent", coding: "Coding agent", pm: "PM agent" };

  // Every navigation starts a new generation. A response that arrives after
  // the user moved on belongs to an old generation and is ignored; the page
  // the user moved to always starts its own request, so it cannot stay empty.
  let generation = 0;
  let activeController = null;
  let loadingPath = null;

  function show() {
    generation++;
    if (activeController) activeController.abort();
    loadingPath = null;
    syncBackButton();
    const path = currentPath();
    document.getElementById("title").textContent = TITLES[path];
    document.getElementById("subtitle").textContent = "";
    document.getElementById("dot").className = "dot";
    document.getElementById("updated").textContent = "Loading…";
    showAlert("");
    document.getElementById("view").replaceChildren(muted("Loading…"));
    refresh();
  }

  function navigate(path) {
    const target = path.replace(/^\/+|\/+$/g, "");
    if (target === currentPath()) return;
    history.pushState({ fromLauncher: currentPath() === "" }, "", "/" + target);
    show();
  }

  // Back from a window: step back in history when we came from the launcher,
  // otherwise (opened straight from a bot) replace this entry with the
  // launcher. Either way history does not grow with every round trip.
  function goBack() {
    if (history.state && history.state.fromLauncher) {
      history.back();  // fires popstate -> show()
    } else {
      history.replaceState({}, "", "/");
      show();
    }
  }

  // Telegram's native Back: on any window other than the launcher.
  function syncBackButton() {
    if (!tg || !tg.BackButton) return;
    if (currentPath()) tg.BackButton.show(); else tg.BackButton.hide();
  }
  if (tg && tg.BackButton) tg.BackButton.onClick(goBack);
  window.addEventListener("popstate", show);

  function showAlert(message) {
    const box = document.getElementById("alert");
    box.textContent = message || "";
    box.style.display = message ? "block" : "none";
  }

  window.addEventListener("error", (event) => showAlert(event.message));
  window.addEventListener("unhandledrejection", (event) => showAlert(String(event.reason)));
  show();
  setInterval(refresh, REFRESH_MS);
