/* ============================================================
   Transia — admin.html : back-office administrateur
   ============================================================ */
(function () {
  var DB = window.DB;
  function get(id) { return document.getElementById(id); }
  var COMMISSION = 0.08;

  /* ---------- Statuts modifiables localement ---------- */
  function getStatuts() { return Store.get("statuts", {}); }
  function statutDe(t) { return getStatuts()[t.id] || t.statut; }
  function setStatut(id, statut) {
    var s = getStatuts();
    s[id] = statut;
    Store.set("statuts", s);
  }

  /* ---------- Affaires (démo + acceptations utilisateur) ---------- */
  function getToutesAffaires() {
    var seed = [{
      ref: "RFQ-00030",
      ligne: "Bordeaux → Genève",
      mode: "Routier",
      offre: "A",
      prix: 1450,
      devise: "EUR",
      commission: Math.round(1450 * COMMISSION),
      date: "14/07/2026 à 11:42",
      transporteur: { nom: "TransAtlas Logistics" }
    }];
    return getAffaires().concat(seed);
  }

  /* ---------- KPI ---------- */
  function renderKpis() {
    var rfqs = getAllRfqs();
    var offresTotal = 0;
    var avecOffres = 0;
    rfqs.forEach(function (r) {
      var n = getOffres(r.ref).length;
      offresTotal += n;
      if (n > 0) avecOffres++;
    });
    var affaires = getToutesAffaires();
    var commissions = affaires.reduce(function (s, a) { return s + (a.commission || 0); }, 0);

    var kpis = [
      { icone: "📋", valeur: rfqs.length, label: "RFQ enregistrées (démo)" },
      { icone: "📝", valeur: offresTotal, label: "Offres déposées" },
      { icone: "✅", valeur: Math.round((affaires.length / Math.max(rfqs.length, 1)) * 100) + " %", label: "Taux d'acceptation (démo)" },
      { icone: "💶", valeur: formatEuro(commissions), label: "Commissions générées (8 %)" }
    ];
    get("kpiGrid").innerHTML = kpis.map(function (k) {
      return "<div class='card' style='text-align:center;'>" +
        "<div class='icon-tile' style='margin:0 auto 12px;'>" + k.icone + "</div>" +
        "<b style='display:block;font-size:26px;color:#0b2545;letter-spacing:-1px;'>" + k.valeur + "</b>" +
        "<span style='font-size:13px;color:#5b6b84;'>" + k.label + "</span></div>";
    }).join("");
  }

  /* ---------- Pays / expansion ---------- */
  function renderPays() {
    var ouverts = Store.get("marches", {});
    var body = get("paysBody");
    body.innerHTML = "";
    DB.pays.forEach(function (p) {
      var actif = p.actif || ouverts[p.pays];
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td><b>" + escapeHtml(p.pays) + "</b></td>" +
        "<td>" + (actif ? "<span class='badge badge-green'>Marché actif</span>" : "<span class='badge badge-grey'>Marché fermé</span>") + "</td>" +
        "<td>" + p.entreprises.toLocaleString("fr-FR") + "</td>" +
        "<td>" + p.transporteurs + "</td>" +
        "<td>" + p.contacts.toLocaleString("fr-FR") + "</td>" +
        "<td>" + p.cotations.toLocaleString("fr-FR") + "</td>" +
        "<td>" + p.affaires + "</td>" +
        "<td><div style='display:flex;align-items:center;gap:8px;'>" +
        "<div style='flex:1;height:7px;background:#eef1f7;border-radius:99px;overflow:hidden;min-width:70px;'>" +
        "<div style='width:" + p.maturite + "%;height:100%;background:var(--blue);border-radius:99px;'></div></div>" +
        "<span style='font-size:12.5px;color:#5b6b84;'>" + p.maturite + "/100</span></div></td>" +
        "<td>" + (actif
          ? "<span class='muted' style='font-size:13px;'>—</span>"
          : "<button class='btn btn-outline btn-sm' data-pays='" + escapeHtml(p.pays) + "'>Ouvrir</button>") + "</td>";
      body.appendChild(tr);
    });

    body.querySelectorAll("button[data-pays]").forEach(function (b) {
      b.addEventListener("click", function () { ouvrirMarche(b.getAttribute("data-pays")); });
    });
  }

  var paysEnCours = null;
  function ouvrirMarche(pays) {
    var p = DB.pays.filter(function (x) { return x.pays === pays; })[0];
    paysEnCours = pays;
    get("marcheInfo").innerHTML =
      "<b>" + escapeHtml(pays) + "</b> — indice de maturité " + p.maturite + "/100<br />" +
      p.entreprises + " entreprises identifiées · " + p.transporteurs + " transporteurs · " + p.contacts + " contacts logistiques structurés";
    openModal("modalMarche");
  }
  get("btnConfirmerMarche").addEventListener("click", function () {
    var m = Store.get("marches", {});
    m[paysEnCours] = true;
    Store.set("marches", m);
    closeModal("modalMarche");
    renderPays();
    toast("Marché " + paysEnCours + " ouvert — décision enregistrée et horodatée.", "ok");
  });

  /* ---------- Vérification transporteurs ---------- */
  function renderVerif() {
    var zone = get("verifList");
    zone.innerHTML = "";
    DB.transporteurs.forEach(function (t) {
      var statut = statutDe(t);
      var div = document.createElement("div");
      div.style.cssText = "border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:12px;";
      var actions = "";
      if (statut === "INSCRIT" || statut === "À VÉRIFIER") {
        actions =
          "<button class='btn btn-primary btn-sm' data-valider='" + t.id + "'>Valider et activer</button>" +
          "<button class='btn btn-outline btn-sm' data-justif='" + t.id + "'>Demander les justificatifs</button>";
      } else if (statut === "VALIDÉ" || statut === "ACTIF") {
        actions = "<button class='btn btn-outline btn-sm' data-suspendre='" + t.id + "'>Suspendre</button>";
      } else if (statut === "SUSPENDU") {
        actions = "<button class='btn btn-outline btn-sm' data-reactiver='" + t.id + "'>Réactiver</button>";
      }
      div.innerHTML =
        "<div style='display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:center;'>" +
        "<div style='display:flex;gap:12px;align-items:center;'>" +
        "<div class='avatar'>" + initials(t.nom) + "</div>" +
        "<div><b style='color:#0b2545;'>" + escapeHtml(t.nom) + "</b> " + badgeStatut(statut) +
        "<br /><span style='font-size:12.5px;color:#5b6b84;'>" + escapeHtml(t.pays + " · " + t.ville) +
        " · " + escapeHtml(t.modes.join(" · ")) + " · Immat. " + escapeHtml(t.immat) + " · TVA " + escapeHtml(t.tva) + "</span></div></div>" +
        "<div style='display:flex;gap:8px;flex-wrap:wrap;'>" + actions + "</div></div>" +
        ((statut === "INSCRIT" || statut === "À VÉRIFIER")
          ? "<div style='margin-top:10px;font-size:12.5px;color:#5b6b84;'>Justificatifs reçus : " +
            (t.justificatifs && t.justificatifs.length
              ? t.justificatifs.map(function (j) { return "<span class='badge badge-blue' style='margin-right:6px;'>" + escapeHtml(j) + "</span>"; }).join("")
              : "<span class='badge badge-amber'>Aucun justificatif</span>") +
            "</div>"
          : "") +
        (statut === "SUSPENDU" && t.motifSuspension
          ? "<div style='margin-top:10px;font-size:12.5px;color:var(--red);'>Motif : " + escapeHtml(t.motifSuspension) + "</div>"
          : "");
      zone.appendChild(div);
    });

    zone.querySelectorAll("[data-valider]").forEach(function (b) {
      b.addEventListener("click", function () {
        setStatut(b.getAttribute("data-valider"), "ACTIF");
        renderVerif();
        toast("Transporteur validé et activé — il peut désormais recevoir les RFQ.", "ok");
      });
    });
    zone.querySelectorAll("[data-justif]").forEach(function (b) {
      b.addEventListener("click", function () {
        toast("Demande de justificatifs envoyée — compte maintenu « à vérifier ».", "ok");
      });
    });
    zone.querySelectorAll("[data-suspendre]").forEach(function (b) {
      b.addEventListener("click", function () {
        setStatut(b.getAttribute("data-suspendre"), "SUSPENDU");
        renderVerif();
        toast("Compte suspendu — motif enregistré dans le journal.", "ok");
      });
    });
    zone.querySelectorAll("[data-reactiver]").forEach(function (b) {
      b.addEventListener("click", function () {
        setStatut(b.getAttribute("data-reactiver"), "ACTIF");
        renderVerif();
        toast("Compte réactivé.", "ok");
      });
    });
  }

  /* ---------- Journal des affaires ---------- */
  function renderAffaires() {
    var body = get("affairesBody");
    var affaires = getToutesAffaires();
    body.innerHTML = "";
    affaires.forEach(function (a) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td><b>" + escapeHtml(a.ref) + "</b></td>" +
        "<td>" + escapeHtml(a.ligne) + "</td>" +
        "<td><span class='mode-badge'>" + modeIcon(a.mode) + " " + escapeHtml(a.mode) + "</span></td>" +
        "<td>Offre " + escapeHtml(a.offre) + "</td>" +
        "<td><b>" + formatEuro(a.prix) + " " + escapeHtml(a.devise || "EUR") + "</b></td>" +
        "<td style='color:var(--green);font-weight:700;'>" + formatEuro(a.commission) + "</td>" +
        "<td style='font-size:13px;'>" + escapeHtml(a.date) + "</td>" +
        "<td style='font-size:13px;'>" + escapeHtml(a.transporteur.nom) + "</td>";
      body.appendChild(tr);
    });
  }

  /* ---------- Métriques phase 6 ---------- */
  function renderMetriques() {
    var rfqs = getAllRfqs();
    var offresTotal = 0, avecOffres = 0, ecarts = [];
    rfqs.forEach(function (r) {
      var o = getOffres(r.ref);
      offresTotal += o.length;
      if (o.length) avecOffres++;
      if (o.length > 1) {
        var conf = o.filter(function (x) { return x.conforme; });
        var pool = conf.length > 1 ? conf : o;
        var vals = pool.map(function (x) { return x.prix; });
        ecarts.push((Math.max.apply(null, vals) - Math.min.apply(null, vals)) / Math.min.apply(null, vals) * 100);
      }
    });
    var ecartMoyen = ecarts.length ? Math.round(ecarts.reduce(function (s, v) { return s + v; }, 0) / ecarts.length) : 0;
    var affaires = getToutesAffaires();
    var m = [
      { label: "Nombre de RFQ", valeur: rfqs.length, note: "dont " + (rfqs.length - rfqs.filter(function(r){return r.origineSource==="user";}).length) + " en jeu de données initial" },
      { label: "Taux de réponse", valeur: Math.round((avecOffres / Math.max(rfqs.length, 1)) * 100) + " %", note: "RFQ ayant reçu au moins une offre" },
      { label: "Offres moyennes par RFQ", valeur: (offresTotal / Math.max(rfqs.length, 1)).toFixed(1), note: "objectif pilote : ≥ 3" },
      { label: "Écart moyen entre offres", valeur: ecartMoyen + " %", note: "mesure de la concurrence générée" },
      { label: "Taux d'acceptation", valeur: Math.round((affaires.length / Math.max(rfqs.length, 1)) * 100) + " %", note: "affaires confirmées / RFQ" },
      { label: "Commissions générées", valeur: formatEuro(affaires.reduce(function (s, a) { return s + (a.commission || 0); }, 0)), note: "8 % sur la partie transport" }
    ];
    get("metriquesGrid").innerHTML = m.map(function (x) {
      return "<div class='card' style='padding:20px;'>" +
        "<span style='font-size:12.5px;color:#5b6b84;text-transform:uppercase;letter-spacing:.6px;'>" + x.label + "</span>" +
        "<b style='display:block;font-size:24px;color:#0b2545;margin:6px 0;'>" + x.valeur + "</b>" +
        "<span style='font-size:12.5px;color:#9aa8c0;'>" + x.note + "</span></div>";
    }).join("");
  }

  /* ---------- Init ---------- */
  renderKpis();
  renderPays();
  renderVerif();
  renderAffaires();
  renderMetriques();
})();
