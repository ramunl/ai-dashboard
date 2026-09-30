
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  const REFRESH_MS = 5000;

  // ---- tiny DOM helpers: every value goes through textContent, never HTML
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function row(label, value) {
    const node = el("div", null, "row");
    node.append(el("span", label), value instanceof Node ? value : el("span", value ?? "—"));
    return node;
  }
  function card(title, ...children) {
    const node = el("section");
    node.append(el("h2", title), ...children);
    return node;
  }
  function muted(text) { return el("div", text, "muted"); }
  function openLink(url) {
    const link = el("a", url);
    link.href = url;
    link.addEventListener("click", (event) => {
      if (tg && tg.openLink) { event.preventDefault(); tg.openLink(url); }
    });
    return link;
  }

