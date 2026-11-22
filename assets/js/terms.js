/* ============================================================
   Transia — assets/js/terms.js
   Version des conditions affichée à l'inscription et transmise
   au serveur. Elle doit correspondre à api/_lib/terms.js : en cas
   d'écart, le serveur refuse l'inscription (TERMS_VERSION_OUTDATED)
   et invite à recharger la page.
   ============================================================ */
window.TRANSIA_TERMS = {
  shipper: "1.0",
  carrier: "1.0"
};

(function () {
  var versions = window.TRANSIA_TERMS;
  document.querySelectorAll("[data-terms-version]").forEach(function (el) {
    var kind = el.getAttribute("data-terms-version");
    if (versions[kind]) el.textContent = versions[kind];
  });
})();
