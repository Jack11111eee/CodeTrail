/* global document, localStorage, window */
/** Apply the saved appearance before CSS paints; no inline script is needed. */
(() => {
  const key = "codetrail:theme";
  const normalize = (value) =>
    value === "light" || value === "dark" ? value : "system";
  const apply = (value) => {
    const theme = normalize(value);
    document.documentElement.dataset.theme = theme;
    const select = document.querySelector("[data-theme-select]");
    if (select) select.value = theme;
  };
  let saved = "system";
  try {
    saved = localStorage.getItem(key) ?? "system";
  } catch {
    // Appearance still works when browser storage is unavailable.
  }
  apply(saved);
  const bind = () => {
    const select = document.querySelector("[data-theme-select]");
    if (!select) return;
    select.value = document.documentElement.dataset.theme;
    select.addEventListener("change", () => {
      const theme = normalize(select.value);
      apply(theme);
      try {
        localStorage.setItem(key, theme);
      } catch {
        // Keep the selected appearance for the current page.
      }
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind, { once: true });
  } else bind();
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) apply(event.newValue);
  });
})();
