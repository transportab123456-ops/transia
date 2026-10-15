/* ============================================================
   Transia — espace-donneur.html : tableau de bord donneur d'ordre
   KPI, mes demandes, offres à valider, affaires, historique
   ============================================================ */
(function () {
  var DB = window.DB;
  function get(id) { return document.getElementById(id); }

  function getConfirmees() { return Store.get("confirmees", {}); }
  function getRefus() { return Store.get("refus", []); }

  var rfqs = getAllRfqs();
  var confirmees = getConfirmees();
  var refusees = getRefus();
  var refsRefusees = refusees.map(function (r) { return r.ref; });

  /* ---------- Statut dérivé d'une RFQ ---------- */
  function statutRfq(r) {
    if (confirmees[r.ref] || r.statut === "CONFIRMÉE") return "CONFIRMÉE";
    if (refsRefusees.indexOf(r.ref) >= 0) return "CLOTURÉE";
    if (Moteur.estValidee(r.ref)) return "RECOMMANDÉE";
    if (getOffres(r.ref).length > 0) return "OFFRE DISPONIBLE";
    return "EN COTATION";
  }

  /* ---------- KPI ---------- */
  function renderKpis() {
    var nbConfirmees = 0, nbOffresValider = 0, nbOffres = 0;
    rfqs.forEach(function (r) {
      var n = getOffres(r.ref).length;
      nbOffres += n;
      var st = statutRfq(r);
      if (st === "CONFIRMÉE") nbConfirmees++;
      if (st === "RECOMMANDÉE" && n > 0) nbOffresValider++;
    });
    var kpis = [
      { icone: "📋", valeur: rfqs.length, label: "Mes demandes" },
      { icone: "📝", valeur: nbOffres, label: "Offres reçues" },
      { icone: "🔔", valeur: nbOffresValider, label: "Offres à valider" },
      { icone: "✅", valeur: nbConfirmees, label: "Transports confirmés" }
    ];
    get("donneurKpis").innerHTML = kpis.map(function (k) {
      return "<div class='card' style='text-align:center;'>" +
        "<div class='icon-tile' style='margin:0 auto 12px;'>" + k.icone + "</div>" +
        "<b style='display:block;font-size:26px;color:#0f2c4e;letter-spacing:-1px;'>" + k.valeur + "</b>" +
        "<span style='font-size:13px;color:#617795;'>" + k.label + "</span></div>";
    }).join("");
  }

  /* ---------- Mes demandes ---------- */
  function renderDemandes() {
    var body = get("mesDemandesBody");
    var empty = get("donneurEmpty");
    body.innerHTML = "";
    empty.classList.toggle("hidden", rfqs.length > 0);
    get("mesDemandesBody").closest(".table-wrap").classList.toggle("hidden", rfqs.length === 0);

    rfqs.forEach(function (r) {
      var n = getOffres(r.ref).length;
      var st = statutRfq(r);
      var tr = document.createElement("tr");
      var action;
      if (st === "CONFIRMÉE") action = "<a class='btn btn-outline btn-sm' href='comparateur.html?ref=" + encodeURIComponent(r.ref) + "'>Voir</a>";
      else if (st === "RECOMMANDÉE") action = "<a class='btn btn-primary btn-sm' href='comparateur.html?ref=" + encodeURIComponent(r.ref) + "'>Valider l'offre</a>";
      else if (st === "OFFRE DISPONIBLE") action = "<a class='btn btn-primary btn-sm' href='comparateur.html?ref=" + encodeURIComponent(r.ref) + "'>Comparer</a>";
      else action = "<a class='btn btn-outline btn-sm' href='comparateur.html?ref=" + encodeURIComponent(r.ref) + "'>Suivre</a>";

      tr.innerHTML =
        "<td><b>" + escapeHtml(r.ref) + "</b></td>" +
        "<td>" + escapeHtml(r.origine.ville) + " → " + escapeHtml(r.dest.ville) +
        "<br /><span class='muted' style='font-size:12px;'>" + escapeHtml(r.origine.pays + " → " + r.dest.pays) + "</span></td>" +
        "<td><span class='mode-badge'>" + modeIcon(r.mode) + " " + escapeHtml(r.mode) + "</span></td>" +
        "<td style='font-size:13px;'>" + escapeHtml(r.origine.date) + "</td>" +
        "<td>" + (n > 0
          ? "<span class='badge badge-blue'>" + n + " reçue" + (n > 1 ? "s" : "") + "</span>"
          : "<span class='muted' style='font-size:13px;'>—</span>") + "</td>" +
        "<td>" + badgeStatut(st) + "</td>" +
        "<td>" + action + "</td>";
      body.appendChild(tr);
    });
  }

  /* ---------- Offres à valider ---------- */
  function renderOffresValider() {
    var zone = get("offresValider");
    var items = rfqs.filter(function (r) {
      return statutRfq(r) === "RECOMMANDÉE" || (statutRfq(r) === "OFFRE DISPONIBLE" && getOffres(r.ref).length > 0);
    });
    if (!items.length) {
      zone.innerHTML = "<p class='muted' style='font-size:13.5px;'>Aucune recommandation en attente. Vous serez notifié dès qu'une offre est prête.</p>";
      return;
    }
    zone.innerHTML = items.map(function (r) {
      var cl = Moteur.classer(getOffres(r.ref));
      var reco = cl.recommandee;
      var validee = Moteur.estValidee(r.ref);
      return "<div style='border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:10px;'>" +
        "<div style='display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;'>" +
        "<b style='color:#0f2c4e;'>" + escapeHtml(r.ref) + "</b>" +
        (validee ? "<span class='badge badge-green'>Prête à valider</span>" : "<span class='badge badge-amber'>Analyse en cours</span>") + "</div>" +
        "<div style='font-size:13px;color:#617795;margin-top:6px;'>" +
        escapeHtml(r.origine.ville + " → " + r.dest.ville) +
        (reco && validee ? " · meilleure offre <b style='color:#1b2d49;'>" + formatEuro(reco.prixComparable) + "</b> · " + escapeHtml(reco.delai) : " · la plateforme compare les offres") +
        "</div>" +
        "<a class='btn btn-primary btn-sm' style='margin-top:10px;' href='comparateur.html?ref=" + encodeURIComponent(r.ref) + "'>" +
        (validee ? "Accepter ou refuser" : "Voir la comparaison") + "</a></div>";
    }).join("");
  }

  /* ---------- Affaires confirmées ---------- */
  function renderAffaires() {
    var zone = get("affairesConfirmees");
    var liste = [];
    rfqs.forEach(function (r) {
      if (confirmees[r.ref] || r.statut === "CONFIRMÉE") {
        liste.push(confirmees[r.ref] || {
          ref: r.ref, ligne: r.origine.ville + " → " + r.dest.ville, prix: r.prixRetenu || 0,
          commission: Math.round((r.prixRetenu || 0) * 0.08), devise: "EUR",
          transporteur: { nom: "Transporteur confirmé" }, date: r.origine.date
        });
      }
    });
    if (!liste.length) {
      zone.innerHTML = "<p class='muted' style='font-size:13.5px;'>Aucun transport confirmé. Acceptez une recommandation pour lancer l'opération.</p>";
      return;
    }
    zone.innerHTML = liste.map(function (a) {
      return "<div style='border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:10px;'>" +
        "<div style='display:flex;justify-content:space-between;gap:10px;align-items:center;'>" +
        "<b style='color:#0f2c4e;'>" + escapeHtml(a.ref) + "</b>" +
        "<span class='badge badge-green'>Confirmée</span></div>" +
        "<div style='font-size:13px;color:#617795;margin-top:6px;'>" + escapeHtml(a.ligne) + "</div>" +
        "<div style='font-size:13.5px;margin-top:6px;'><b style='color:#1b2d49;'>" + formatEuro(a.prix) + " " + escapeHtml(a.devise || "EUR") + "</b>" +
        " · <span style='color:#617795;'>transporteur dévoilé : " + escapeHtml(a.transporteur.nom) + "</span></div>" +
        "<div style='font-size:12px;color:#9fb2cc;margin-top:4px;'>" + escapeHtml(a.date || "") + "</div></div>";
    }).join("");
  }

  /* ---------- Historique ---------- */
  function renderHistorique() {
    var zone = get("historiqueList");
    var items = [];
    refusees.forEach(function (x) {
      items.push({ ref: x.ref, type: "Refus", info: "Motif : " + x.motif, date: x.date, badge: "badge-grey" });
    });
    rfqs.forEach(function (r) {
      if (statutRfq(r) === "CONFIRMÉE") {
        items.push({ ref: r.ref, type: "Affaire confirmée", info: "Prix accepté : " + formatEuro(confirmees[r.ref] ? confirmees[r.ref].prix : (r.prixRetenu || 0)), date: confirmees[r.ref] ? confirmees[r.ref].date : "—", badge: "badge-green" });
      }
    });
    if (!items.length) {
      zone.innerHTML = "<p class='muted' style='font-size:13.5px;'>L'historique se remplira au fil de vos opérations (demandes, acceptations, refus).</p>";
      return;
    }
    zone.innerHTML = items.map(function (it) {
      return "<div style='display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:11px 0;border-bottom:1px solid var(--line);'>" +
        "<div><b style='color:#0f2c4e;'>" + escapeHtml(it.ref) + "</b> <span class='badge " + it.badge + "'>" + escapeHtml(it.type) + "</span>" +
        "<br /><span style='font-size:13px;color:#617795;'>" + escapeHtml(it.info) + "</span></div>" +
        "<span style='font-size:12.5px;color:#9fb2cc;white-space:nowrap;'>" + escapeHtml(it.date || "") + "</span></div>";
    }).join("");
  }

  renderKpis();
  renderDemandes();
  renderOffresValider();
  renderAffaires();
  renderHistorique();
})();
