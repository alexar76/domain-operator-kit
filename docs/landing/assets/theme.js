// Run before CSS so a saved preference never flashes the other theme. No inline script/CSP exception.
(function () {
  "use strict";
  var root = document.documentElement;
  var system = window.matchMedia("(prefers-color-scheme: dark)");
  var key = "domains-theme";
  var choice;
  try { choice = localStorage.getItem(key); } catch (_) { /* Storage may be disabled. */ }
  var labels = {
    en: ["Switch to dark theme", "Switch to light theme"],
    ru: ["Включить тёмную тему", "Включить светлую тему"],
    es: ["Activar tema oscuro", "Activar tema claro"],
    fr: ["Activer le thème sombre", "Activer le thème clair"],
    zh: ["切换到深色主题", "切换到浅色主题"]
  };
  function updateButton() {
    var dark = root.dataset.theme === "dark";
    var label = (labels[root.lang.slice(0, 2)] || labels.en)[dark ? 1 : 0];
    document.querySelectorAll("[data-theme-toggle]").forEach(function (button) {
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      button.setAttribute("aria-pressed", String(dark));
    });
  }
  function apply() {
    root.dataset.theme = choice === "dark" || choice === "light" ? choice : system.matches ? "dark" : "light";
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = root.dataset.theme === "dark" ? "#0f1420" : "#f4f2ec";
    updateButton();
  }
  apply();
  system.addEventListener("change", apply);
  window.addEventListener("storage", function (event) {
    if (event.key === key || event.key === null) { choice = event.newValue; apply(); }
  });
  document.addEventListener("DOMContentLoaded", function () {
    updateButton();
    document.querySelectorAll("[data-theme-toggle]").forEach(function (button) {
      button.addEventListener("click", function () {
        choice = root.dataset.theme === "dark" ? "light" : "dark";
        try { localStorage.setItem(key, choice); } catch (_) { /* Keep the in-memory preference. */ }
        apply();
      });
    });
    new MutationObserver(updateButton).observe(root, { attributes: true, attributeFilter: ["lang"] });
  });
})();
