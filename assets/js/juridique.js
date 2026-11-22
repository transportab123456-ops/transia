/* ============================================================
   Transia — assets/js/juridique.js
   Rendu des données de assets/js/legal-data.js sur juridique.html
   ============================================================ */
(function () {
  "use strict";

  var DATA = window.LEGAL_DATA;
  if (!DATA) return;

  var TONS = { high: "Régime contraignant", medium: "Vigilance", low: "Peu encadré" };

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- Encart mise à jour ---------- */
  if (el("legalUpdated")) el("legalUpdated").textContent = DATA.miseAJour;

  /* ---------- Les trois qualifications ---------- */
  var q = el("legalQualifications");
  if (q) {
    q.innerHTML = DATA.qualifications.map(function (x) {
      return "<article class='card legal-card'>" +
        "<div class='legal-card-head'><h3>" + esc(x.titre) + "</h3>" +
        "<span class='legal-badge legal-badge--" + esc(x.ton) + "'>" + esc(TONS[x.ton] || "") + "</span></div>" +
        "<p>" + esc(x.indice) + "</p>" +
        "<ul class='legal-list'>" + x.consequences.map(function (c) {
          return "<li>" + esc(c) + "</li>";
        }).join("") + "</ul></article>";
    }).join("");
  }

  /* ---------- Filtres ---------- */
  var filters = el("legalFilters");
  var zones = ["Tous", "Union européenne", "Hors Union européenne"];
  if (filters) {
    filters.innerHTML = zones.map(function (z, i) {
      return "<button class='chip" + (i === 0 ? " active" : "") + "' data-zone='" + esc(z) + "'>" + esc(z) + "</button>";
    }).join("");
    filters.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-zone]");
      if (!b) return;
      [].forEach.call(filters.querySelectorAll("button"), function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      renderPays(b.getAttribute("data-zone"));
    });
  }

  /* ---------- Fiches pays ---------- */
  function renderPays(zone) {
    var zone2 = el("legalPays");
    if (!zone2) return;
    var list = DATA.pays.filter(function (p) { return zone === "Tous" || p.zone === zone; });
    zone2.innerHTML = list.map(function (p) {
      return "<article class='legal-card legal-country'>" +
        "<div class='legal-card-head'>" +
          "<span class='legal-flag' aria-hidden='true'>" + p.drapeau + "</span>" +
          "<h3>" + esc(p.nom) + "</h3>" +
          "<span class='legal-badge legal-badge--" + esc(p.ton) + "'>" + esc(TONS[p.ton] || "") + "</span>" +
        "</div>" +
        "<p class='legal-status'>" + esc(p.statut) + "</p>" +
        "<dl>" +
          "<dt>Exercice de l'activité</dt><dd>" + esc(p.exercice) + "</dd>" +
          "<dt>Autorité compétente</dt><dd>" + esc(p.autorite) + "</dd>" +
          "<dt>Obligations</dt><dd><ul class='legal-list'>" + p.obligations.map(function (o) {
            return "<li>" + esc(o) + "</li>";
          }).join("") + "</ul></dd>" +
          "<dt>Volet numérique</dt><dd>" + esc(p.numerique) + "</dd>" +
          "<dt>TVA et facturation</dt><dd>" + esc(p.tva) + "</dd>" +
          "<dt>Point de vigilance</dt><dd class='legal-vigilance'>" + esc(p.vigilance) + "</dd>" +
        "</dl>" +
        "<div class='legal-sources'>" + p.sources.map(function (s) {
          return "<a href='" + esc(s.u) + "' target='_blank' rel='noopener noreferrer'>" + esc(s.t) + " ↗</a>";
        }).join("") + "</div>" +
        "</article>";
    }).join("");
  }
  renderPays("Tous");

  /* ---------- Tableau des plafonds ---------- */
  var table = el("legalConvTable");
  if (table) {
    table.innerHTML = DATA.conventions.map(function (c) {
      return "<tr><td><b>" + esc(c.mode) + "</b></td><td>" + esc(c.nom) + "</td><td>" +
        esc(c.plafond) + "</td><td>" + esc(c.delai) + "</td></tr>";
    }).join("");
  }

  /* ---------- Détail des conventions ---------- */
  var conv = el("legalConventions");
  if (conv) {
    conv.innerHTML = DATA.conventions.map(function (c) {
      return "<article class='card legal-card'>" +
        "<div class='legal-card-head'><h3>" + esc(c.nom) + "</h3><span class='legal-tag'>" + esc(c.mode) + "</span></div>" +
        "<p><b>" + esc(c.annee) + "</b> — " + esc(c.portee) + "</p>" +
        "<ul class='legal-list'>" + c.points.map(function (pt) { return "<li>" + esc(pt) + "</li>"; }).join("") + "</ul>" +
        "<div class='legal-sources'><a href='" + esc(c.source) + "' target='_blank' rel='noopener noreferrer'>Texte officiel ↗</a></div>" +
        "</article>";
    }).join("");
  }

  /* ---------- Obligations transverses ---------- */
  var obl = el("legalObligations");
  if (obl) {
    obl.innerHTML = DATA.obligations.map(function (o) {
      return "<article class='card legal-card'>" +
        "<h3>" + esc(o.titre) + "</h3>" +
        "<p>" + esc(o.texte) + "</p>" +
        "<div class='legal-sources'><a href='" + esc(o.source) + "' target='_blank' rel='noopener noreferrer'>Source officielle ↗</a></div>" +
        "</article>";
    }).join("");
  }

  /* ---------- Checklist ---------- */
  var chk = el("legalChecklist");
  if (chk) {
    chk.innerHTML = DATA.checklist.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("");
  }

  /* ---------- Liste consolidée des sources ---------- */
  var sourceList = el("legalSourceList");
  if (sourceList) {
    var seen = {};
    var rows = [];
    DATA.pays.forEach(function (p) {
      p.sources.forEach(function (s) { if (!seen[s.u]) { seen[s.u] = 1; rows.push(s); } });
    });
    DATA.conventions.forEach(function (c) {
      if (!seen[c.source]) { seen[c.source] = 1; rows.push({ t: c.nom + " — texte officiel", u: c.source }); }
    });
    DATA.obligations.forEach(function (o) {
      if (!seen[o.source]) { seen[o.source] = 1; rows.push({ t: o.titre, u: o.source }); }
    });
    sourceList.innerHTML = "<h3>Sources officielles</h3><ul class='legal-list legal-source-grid'>" +
      rows.map(function (r) {
        return "<li><a href='" + esc(r.u) + "' target='_blank' rel='noopener noreferrer'>" + esc(r.t) + "</a></li>";
      }).join("") + "</ul>";
  }

  /* ---------- Ancre : la page grandit après le rendu, on recale ---------- */
  if (window.location.hash) {
    var target = document.querySelector(window.location.hash);
    if (target) setTimeout(function () { target.scrollIntoView(); }, 80);
  }
})();
