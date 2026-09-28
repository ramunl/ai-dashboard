// Telegram Mini App bridge: the WebApp object and the page's color scheme.
const tg = window.Telegram && window.Telegram.WebApp;

function applyColorScheme() {
  if (tg && tg.colorScheme) document.documentElement.dataset.theme = tg.colorScheme;
}

function initTelegram() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  applyColorScheme();
  if (tg.onEvent) tg.onEvent("themeChanged", applyColorScheme);
}
