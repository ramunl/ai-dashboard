  async function refresh() {
    const initData = tg ? tg.initData : "";
    if (!initData) {
      showAlert("Open this dashboard from a bot's Dashboard button in Telegram.");
      return;
    }
    const path = currentPath();
    if (loadingPath === path) { console.debug("Refresh skipped: request in flight"); return; }
    loadingPath = path;
    const mine = generation;
    const [api, render] = PAGES[path];
    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`/api/${api}`, { headers: { Authorization: "tma " + initData }, cache: "no-store", signal: controller.signal });
      const body = await response.json();
      if (mine !== generation) { console.debug("Response ignored: navigation changed"); return; }
      if (!response.ok) { showAlert(body.error || `HTTP ${response.status}`); return; }
      const page = render(body);
      document.getElementById("dot").className = "dot " + page.dot;
      showAlert(page.alert);
      document.getElementById("view").replaceChildren(...page.nodes);
      const age = typeof body.age_seconds === "number" ? ` · data ${Math.round(body.age_seconds)} s old` : "";
      document.getElementById("updated").textContent =
        "Updated " + new Date().toLocaleTimeString() + age;
    } catch (error) {
      if (mine === generation) showAlert("Cannot reach the dashboard: " + (error.name === "AbortError" ? "Request timed out. Retrying shortly." : error.message));
    } finally {
      clearTimeout(timeout);
      if (activeController === controller) activeController = null;
      if (mine === generation && loadingPath === path) loadingPath = null;
    }
  }

