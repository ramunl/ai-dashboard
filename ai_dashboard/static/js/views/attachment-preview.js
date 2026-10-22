// URLs belong to this rendered view, not to the upload's File objects.
function attachmentPreview(images, disabled) {
  const box = el("div", null, "attachment-preview");
  const owner = box.ownerDocument;
  const entries = new Map();
  let suspended = false;
  let disposed = false;

  function release(entry) {
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.url = null;
    entry.picture.removeAttribute("src");
  }

  function clear() {
    for (const entry of entries.values()) release(entry);
    entries.clear();
    box.replaceChildren();
  }

  function render() {
    if (disposed || suspended || !box.isConnected) return;
    for (const [image, entry] of entries) {
      if (!images.includes(image)) {
        release(entry);
        entry.figure.remove();
        entries.delete(image);
      }
    }
    for (const image of images) {
      if (entries.has(image)) continue;
      const figure = el("figure", null, "attachment-thumb");
      const picture = el("img");
      picture.alt = image.file.name;
      picture.decoding = "async";
      const caption = el("figcaption", image.file.name);
      const fallback = el("span", "Preview unavailable", "attachment-fallback");
      fallback.hidden = true;
      const remove = el("button", "Remove", "row-button work-secondary");
      remove.type = "button";
      remove.disabled = disabled;
      remove.setAttribute("aria-label", `Remove image ${image.file.name}`);
      const entry = { figure, picture, url: null };
      const unavailable = () => {
        release(entry);
        picture.hidden = true;
        fallback.hidden = false;
      };
      picture.addEventListener("error", unavailable);
      try {
        entry.url = URL.createObjectURL(image.file);
        picture.src = entry.url;
      } catch {
        unavailable();
      }
      remove.addEventListener("click", () => {
        const index = images.indexOf(image);
        if (index < 0) return;
        images.splice(index, 1);
        const next = figure.nextElementSibling || figure.previousElementSibling;
        render();
        const target = next?.querySelector("button") ||
          box.nextElementSibling?.querySelector("input");
        target?.focus();
      });
      figure.append(picture, caption, fallback, remove);
      entries.set(image, entry);
      box.append(figure);
    }
  }

  function reset(event) {
    if (!event.target.contains(box) || event.defaultPrevented) return;
    images.splice(0);
    clear();
  }

  function hide() {
    suspended = true;
    clear();
  }

  function show() {
    if (!suspended || disposed) return;
    suspended = false;
    render();
  }

  // Covers router navigation and replaced cards, including unused render
  // results when the app suppresses a refresh while a field has focus.
  const observer = new MutationObserver(() => {
    if (box.isConnected) {
      render();
      return;
    }
    disposed = true;
    clear();
    observer.disconnect();
    owner.removeEventListener("reset", reset);
    window.removeEventListener("pagehide", hide);
    window.removeEventListener("pageshow", show);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("reset", reset);
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", show);
  render();
  return { node: box, render };
}
