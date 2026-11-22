/* ============================================================
   Transia — admin.html : back-office administrateur
   ============================================================ */
(function () {
  var DB = window.DB;
  function get(id) { return document.getElementById(id); }
  var Commission = window.Commission;

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
      commission: Commission.calculer(1450).commission,
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
      { icone: "", valeur: rfqs.length, label: "RFQ enregistrées (démo)" },
      { icone: "", valeur: offresTotal, label: "Offres déposées" },
      { icone: "", valeur: Math.round((affaires.length / Math.max(rfqs.length, 1)) * 100) + " %", label: "Taux d'acceptation (démo)" },
      { icone: "", valeur: formatEuro(commissions), label: "Commissions générées (barème)" }
    ];
    get("kpiGrid").innerHTML = kpis.map(function (k) {
      return "<div class='card' style='text-align:center;'>" +
        (k.icone ? "<div class='icon-tile' style='margin:0 auto 12px;'>" + k.icone + "</div>" : "") +
        "<b style='display:block;font-size:26px;color:#0f2c4e;letter-spacing:-1px;'>" + k.valeur + "</b>" +
        "<span style='font-size:13px;color:#617795;'>" + k.label + "</span></div>";
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
        "<div style='flex:1;height:7px;background:#edf1f7;border-radius:99px;overflow:hidden;min-width:70px;'>" +
        "<div style='width:" + p.maturite + "%;height:100%;background:var(--blue);border-radius:99px;'></div></div>" +
        "<span style='font-size:12.5px;color:#617795;'>" + p.maturite + "/100</span></div></td>" +
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
        "<div><b style='color:#0f2c4e;'>" + escapeHtml(t.nom) + "</b> " + badgeStatut(statut) +
        "<br /><span style='font-size:12.5px;color:#617795;'>" + escapeHtml(t.pays + " · " + t.ville) +
        " · " + escapeHtml(t.modes.join(" · ")) + " · Immat. " + escapeHtml(t.immat) + " · TVA " + escapeHtml(t.tva) + "</span></div></div>" +
        "<div style='display:flex;gap:8px;flex-wrap:wrap;'>" + actions + "</div></div>" +
        ((statut === "INSCRIT" || statut === "À VÉRIFIER")
          ? "<div style='margin-top:10px;font-size:12.5px;color:#617795;'>Justificatifs reçus : " +
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
        "<td><span class='mode-badge'>" + escapeHtml(a.mode) + "</span></td>" +
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
      { label: "Commissions générées", valeur: formatEuro(affaires.reduce(function (s, a) { return s + (a.commission || 0); }, 0)), note: "Barème dégressif sur la partie transport" }
    ];
    get("metriquesGrid").innerHTML = m.map(function (x) {
      return "<div class='card' style='padding:20px;'>" +
        "<span style='font-size:12.5px;color:#617795;text-transform:uppercase;letter-spacing:.6px;'>" + x.label + "</span>" +
        "<b style='display:block;font-size:24px;color:#0f2c4e;margin:6px 0;'>" + x.valeur + "</b>" +
        "<span style='font-size:12.5px;color:#9fb2cc;'>" + x.note + "</span></div>";
    }).join("");
  }

  /* ---------- File de travail (à faire aujourd'hui) ---------- */
  function renderTodo() {
    var rfqs = getAllRfqs();
    var aValider = rfqs.filter(function (r) {
      return getOffres(r.ref).length > 0 && !Moteur.estValidee(r.ref) &&
        !getConfirmees()[r.ref] && !getRefus().some(function (x) { return x.ref === r.ref; });
    }).length;
    var aClarifier = 0;
    rfqs.forEach(function (r) {
      var cl = Moteur.classer(getOffres(r.ref));
      aClarifier += cl.aVerifier.length;
    });
    var aVerif = DB.transporteurs.filter(function (t) {
      var s = statutDe(t); return s === "INSCRIT" || s === "À VÉRIFIER";
    }).length;
    var incOuverts = incidents.filter(function (i) { return i.statut !== "Résolu" && i.statut !== "Classé"; }).length;
    var sansOffre = rfqs.filter(function (r) { return getOffres(r.ref).length === 0; }).length;

    var items = [
      { icone: "", n: aValider, label: "recommandations à valider", urgent: aValider > 0 },
      { icone: "", n: aClarifier, label: "offres à clarifier", urgent: false },
      { icone: "", n: aVerif, label: "transporteurs à vérifier", urgent: false },
      { icone: "", n: incOuverts, label: "incidents à traiter", urgent: incOuverts > 0 },
      { icone: "", n: sansOffre, label: "RFQ sans offre", urgent: false },
      { icone: "", n: 0, label: "factures en retard", urgent: false }
    ];
    get("todoGrid").innerHTML = items.map(function (i) {
      return "<div class='card' style='padding:16px;" + (i.urgent ? "border-color:var(--amber);" : "") + "'>" +
        "<div style='display:flex;align-items:center;gap:10px;'>" +
        "<span style='font-size:22px;'>" + i.icone + "</span>" +
        "<div><b style='display:block;font-size:22px;color:#0f2c4e;line-height:1.1;'>" + i.n + "</b>" +
        "<span style='font-size:12.5px;color:#617795;'>" + i.label + "</span></div></div></div>";
    }).join("");
  }

  /* ---------- Validation de recommandation (comparateur) ---------- */
  function getConfirmees() { return Store.get("confirmees", {}); }
  function getRefus() { return Store.get("refus", []); }

  function renderAdminSelectRfq() {
    var sel = get("adminSelectRfq");
    if (!sel) return;
    var actuel = sel.value;
    sel.innerHTML = "";
    var rfqs = getAllRfqs().filter(function (r) { return getOffres(r.ref).length > 0; });
    rfqs.forEach(function (r) {
      var o = document.createElement("option");
      o.value = r.ref;
      o.textContent = r.ref + " — " + r.origine.ville + " → " + r.dest.ville + " (" + getOffres(r.ref).length + " offres)";
      sel.appendChild(o);
    });
    if (actuel && rfqs.some(function (r) { return r.ref === actuel; })) sel.value = actuel;
    renderClassement();
  }

  function renderClassement() {
    var zone = get("adminClassement");
    if (!zone) return;
    var sel = get("adminSelectRfq");
    var ref = sel.value;
    if (!ref) { zone.innerHTML = "<p class='muted'>Aucune offre à analyser pour l'instant.</p>"; return; }
    var rfq = findRfq(ref);
    var offres = getOffres(ref);
    var cl = Moteur.classer(offres);
    var validee = Moteur.getValidations()[ref];
    var dejaAffaire = getConfirmees()[ref];

    var rang = 1;
    var lignes = cl.conforme.map(function (o) { return { o: o, rang: rang++ }; });

    var table =
      "<div class='table-wrap'><table class='table'><thead><tr>" +
      "<th>Rang</th><th>Offre</th><th>Transport</th><th>Frais obl.</th><th>Total comparable</th><th>Devise</th><th>Délai</th><th>Conformité</th>" +
      "</tr></thead><tbody>" +
      lignes.map(function (x) {
        var o = x.o;
        return "<tr" + (x.rang === 1 ? " style='background:var(--blue-light);'" : "") + ">" +
          "<td><b>" + x.rang + "</b></td>" +
          "<td><b>" + escapeHtml(o.lettre) + "</b>" + (x.rang === 1 ? " <span class='badge badge-blue'>Proposition moteur</span>" : "") + "</td>" +
          "<td>" + formatEuro(o.transportComparaison) + "</td>" +
          "<td>" + (o.fraisComparaison ? formatEuro(o.fraisComparaison) : "—") + "</td>" +
          "<td><b>" + formatEuro(o.prixComparable) + "</b></td>" +
          "<td>" + escapeHtml(o.devise) + (o.devise !== "EUR" ? " <span style='font-size:11px;color:#9fb2cc;'>(×" + o.tauxChange + ")</span>" : "") + "</td>" +
          "<td>" + escapeHtml(o.delai) + "</td>" +
          "<td><span class='badge badge-green'>Conforme</span></td></tr>";
      }).join("") +
      cl.aVerifier.map(function (o) {
        return "<tr><td>—</td><td><b>" + escapeHtml(o.lettre) + "</b></td>" +
          "<td>" + formatEuro(o.transportComparaison) + "</td><td>à préciser</td>" +
          "<td style='color:#96650f;'>à déterminer</td><td>" + escapeHtml(o.devise) + "</td>" +
          "<td>" + escapeHtml(o.delai) + "</td><td><span class='badge badge-amber'>À vérifier</span></td></tr>";
      }).join("") +
      cl.ecartees.map(function (o) {
        return "<tr style='opacity:.65;'><td>—</td><td><b>" + escapeHtml(o.lettre) + "</b></td>" +
          "<td>" + formatEuro(o.transportComparaison) + "</td><td>—</td>" +
          "<td>" + formatEuro(o.prixComparable) + "</td><td>" + escapeHtml(o.devise) + "</td>" +
          "<td>" + escapeHtml(o.delai) + "</td><td><span class='badge badge-red'>Non conforme</span></td></tr>";
      }).join("") +
      "</tbody></table></div>";

    var explication = "";
    if (cl.recommandee) {
      explication = "<div class='info-banner' style='margin-top:16px;'> <span><b>Pourquoi l'offre " + escapeHtml(cl.recommandee.lettre) + " est n°1 :</b> conforme — prix comparable le plus bas (" + formatEuro(cl.recommandee.prixComparable) + ") — délai compatible — transporteur validé.</span></div>";
    }

    var actions;
    if (dejaAffaire) {
      actions = "<div class='info-banner' style='margin-top:14px;'> <span>Affaire confirmée — recommandation déjà acceptée et dévoilée.</span></div>";
    } else if (validee) {
      actions = "<div class='info-banner' style='margin-top:14px;'>✓ <span><b>Recommandation validée</b> le " + escapeHtml(validee.date) + " par " + escapeHtml(validee.par) +
        (validee.motif ? " · écart au n°1 motivé : " + escapeHtml(validee.motif) : "") +
        ". Envoyée au client pour acceptation. <a href='comparateur.html?ref=" + encodeURIComponent(ref) + "'>Ouvrir le comparateur →</a></span></div>";
    } else if (cl.recommandee) {
      actions =
        "<div style='display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;align-items:center;'>" +
        "<button class='btn btn-primary' id='btnValiderReco'>✓ Valider l'offre " + escapeHtml(cl.recommandee.lettre) + " comme recommandée</button>" +
        "<button class='btn btn-outline' id='btnOverride'>Retenir une autre offre (motif obligatoire)</button>" +
        "</div>" +
        "<p class='form-note'>Aucune recommandation n'est envoyée automatiquement au client — contrôle humain obligatoire au lancement.</p>" +
        "<div id='overrideZone' class='hidden' style='margin-top:14px;border:1px solid var(--line);border-radius:10px;padding:16px;'>" +
        "<label style='font-weight:600;font-size:14px;'>Motif de l'écart (journalisé)</label>" +
        "<select id='overrideMotif' style='margin-top:8px;'>" +
        "<option value=''>— Choisir un motif —</option>" +
        "<option>Document expiré</option><option>Incident récent</option><option>Offre non claire</option>" +
        "<option>Disponibilité non confirmée</option><option>Risque opérationnel</option><option>Erreur de cotation</option>" +
        "</select>" +
        "<div id='overrideOffres' style='margin-top:10px;'></div>" +
        "<button class='btn btn-primary btn-sm' id='btnConfirmerOverride' style='margin-top:10px;'>Confirmer l'écart</button>" +
        "</div>";
    } else {
      actions = "<p class='muted' style='margin-top:14px;'>Aucune offre conforme — clarification requise avant recommandation.</p>";
    }

    zone.innerHTML = table + explication + actions;

    var bv = get("btnValiderReco");
    if (bv) bv.addEventListener("click", function () {
      Moteur.valider(ref, cl.recommandee.lettre, null);
      renderClassement(); renderTodo();
      toast("Recommandation « offre " + cl.recommandee.lettre + " » validée — envoyée au client.", "ok");
    });
    var bo = get("btnOverride");
    if (bo) bo.addEventListener("click", function () {
      get("overrideZone").classList.toggle("hidden");
    });
    var zoneOffres = get("overrideOffres");
    if (zoneOffres) {
      zoneOffres.innerHTML = cl.conforme.map(function (o, i) {
        return "<label style='display:flex;gap:8px;align-items:center;font-size:14px;margin-bottom:6px;'>" +
          "<input type='radio' name='overrideChoix' value='" + escapeHtml(o.lettre) + "' style='width:auto;'" + (i === 1 ? " checked" : "") + " /> " +
          "Offre " + escapeHtml(o.lettre) + " — " + formatEuro(o.prixComparable) + "</label>";
      }).join("");
    }
    var bco = get("btnConfirmerOverride");
    if (bco) bco.addEventListener("click", function () {
      var motif = get("overrideMotif").value;
      var choisi = document.querySelector('input[name="overrideChoix"]:checked');
      if (!motif) { toast("Sélectionnez un motif d'écart (obligatoire, journalisé).", "err"); return; }
      if (!choisi) { toast("Sélectionnez l'offre à retenir.", "err"); return; }
      if (choisi.value === cl.recommandee.lettre) { toast("Cette offre est déjà la proposition n°1 du moteur.", "err"); return; }
      Moteur.valider(ref, choisi.value, motif);
      renderClassement(); renderTodo();
      toast("Écart enregistré : retenue offre " + choisi.value + " au lieu de " + cl.recommandee.lettre + " — motif journalisé.", "ok");
    });
  }

  /* ---------- Donneurs d'ordre ---------- */
  function renderDonneurs() {
    var body = get("donneursBody");
    if (!body) return;
    body.innerHTML = "";
    donneurs.forEach(function (d) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td><b>" + escapeHtml(d.entreprise) + "</b></td>" +
        "<td>" + escapeHtml(d.pays) + "</td>" +
        "<td>" + escapeHtml(d.contact) + "</td>" +
        "<td>" + d.rfq + "</td>" +
        "<td>" + d.affaires + "</td>" +
        "<td>" + (d.statut === "Actif" ? "<span class='badge badge-green'>Actif</span>" : "<span class='badge badge-amber'>À vérifier</span>") + "</td>";
      body.appendChild(tr);
    });
  }

  /* ---------- Cotations (vue normalisée) ---------- */
  function renderCotations() {
    var body = get("cotationsBody");
    if (!body) return;
    body.innerHTML = "";
    var rows = [];
    getAllRfqs().forEach(function (r) {
      Moteur.classer(getOffres(r.ref)).conforme.concat(
        Moteur.classer(getOffres(r.ref)).aVerifier
      ).forEach(function (o) {
        rows.push({ ref: r.ref, o: o });
      });
    });
    if (!rows.length) {
      body.innerHTML = "<tr><td colspan='8' class='muted'>Aucune cotation enregistrée.</td></tr>";
      return;
    }
    rows.forEach(function (x) {
      var o = x.o;
      var tr = document.createElement("tr");
      var statutBadge = o.statutTechnique === "A_VERIFIER"
        ? "<span class='badge badge-amber'>À vérifier</span>"
        : (o.statutTechnique === "NON_CONFORME" ? "<span class='badge badge-red'>Non conforme</span>" : "<span class='badge badge-green'>Conforme</span>");
      tr.innerHTML =
        "<td><b>" + escapeHtml(x.ref) + "</b></td>" +
        "<td>" + escapeHtml(o.lettre) + "</td>" +
        "<td>" + formatEuro(o.transportComparaison) + "</td>" +
        "<td>" + (o.fraisComparaison ? formatEuro(o.fraisComparaison) : "—") + "</td>" +
        "<td><b>" + (o.prixComparable == null ? "à déterminer" : formatEuro(o.prixComparable)) + "</b></td>" +
        "<td>" + escapeHtml(o.devise) + "</td>" +
        "<td>" + escapeHtml(o.delai) + "</td>" +
        "<td>" + statutBadge + "</td>";
      body.appendChild(tr);
    });
  }

  /* ---------- Incidents ---------- */
  function renderIncidents() {
    var zone = get("incidentsList");
    if (!zone) return;
    var ouverts = incidents.filter(function (i) { return i.statut !== "Résolu" && i.statut !== "Classé"; }).length;
    get("incidentsCount").textContent = ouverts + " à traiter";
    zone.innerHTML = "";
    incidents.forEach(function (inc, idx) {
      var badge = inc.statut === "Résolu" ? "badge-green" : (inc.statut === "Classé" ? "badge-grey" : (inc.priorite === "Critique" ? "badge-red" : "badge-amber"));
      var div = document.createElement("div");
      div.style.cssText = "border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px;";
      div.innerHTML =
        "<div style='display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;'>" +
        "<div><b style='color:#0f2c4e;'>" + escapeHtml(inc.type) + "</b> " +
        "<span class='badge " + badge + "'>" + escapeHtml(inc.priorite) + "</span>" +
        "<br /><span style='font-size:12.5px;color:#617795;'>" + escapeHtml(inc.parties) + " · " + escapeHtml(inc.date) + " · statut " + escapeHtml(inc.statut) + "</span></div>" +
        (inc.statut !== "Résolu" && inc.statut !== "Classé"
          ? "<div style='display:flex;gap:8px;'><button class='btn btn-primary btn-sm' data-resoudre='" + idx + "'>Résoudre</button>" +
            "<button class='btn btn-outline btn-sm' data-classer='" + idx + "'>Classer</button></div>"
          : "") +
        "</div>" +
        "<p style='font-size:13px;color:#617795;margin-top:8px;'>" + escapeHtml(inc.description) + "</p>";
      zone.appendChild(div);
    });
    zone.querySelectorAll("[data-resoudre]").forEach(function (b) {
      b.addEventListener("click", function () { incidents[+b.getAttribute("data-resoudre")].statut = "Résolu"; renderIncidents(); renderTodo(); toast("Incident marqué résolu — journalisé.", "ok"); });
    });
    zone.querySelectorAll("[data-classer]").forEach(function (b) {
      b.addEventListener("click", function () { incidents[+b.getAttribute("data-classer")].statut = "Classé"; renderIncidents(); renderTodo(); toast("Incident classé.", "ok"); });
    });
  }

  /* ---------- Contacts internationaux ---------- */
  function renderContacts() {
    var body = get("contactsBody");
    if (!body) return;
    body.innerHTML = "";
    contacts.forEach(function (c) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td><b>" + escapeHtml(c.entreprise) + "</b></td>" +
        "<td>" + escapeHtml(c.pays) + "</td>" +
        "<td><span class='badge badge-blue'>" + escapeHtml(c.type) + "</span></td>" +
        "<td>" + escapeHtml(c.contact) + "</td>" +
        "<td>" + escapeHtml(c.fonction) + "</td>" +
        "<td style='font-size:12.5px;'>" + escapeHtml(c.source) + "</td>" +
        "<td style='font-size:12.5px;'>" + escapeHtml(c.date) + "</td>";
      body.appendChild(tr);
    });
  }

  /* ---------- Rapports ---------- */
  function renderRapports() {
    var zone = get("rapportsGrid");
    if (!zone) return;
    var rfqs = getAllRfqs();
    var parLigne = {};
    var totalOffres = 0;
    rfqs.forEach(function (r) {
      var key = r.origine.pays + " → " + r.dest.pays;
      var offres = getOffres(r.ref);
      totalOffres += offres.length;
      if (!parLigne[key]) parLigne[key] = { rfq: 0, offres: 0, acceptees: 0, prix: [] };
      parLigne[key].rfq++;
      parLigne[key].offres += offres.length;
      var conf = Moteur.classer(offres).conforme;
      if (conf.length) parLigne[key].prix.push(conf[0].prixComparable);
      if (getConfirmees()[r.ref]) parLigne[key].acceptees++;
    });

    var rapports = Object.keys(parLigne).map(function (k) {
      var d = parLigne[k];
      var mediane = d.prix.length ? d.prix.slice().sort(function (a, b) { return a - b; })[Math.floor(d.prix.length / 2)] : 0;
      return { ligne: k, rfq: d.rfq, offres: d.offres, moy: (d.offres / d.rfq).toFixed(1), mediane: mediane, taux: Math.round((d.acceptees / d.rfq) * 100) };
    });

    zone.innerHTML = rapports.map(function (x) {
      return "<div class='card' style='padding:18px;'>" +
        "<b style='color:#0f2c4e;font-size:15px;'>" + escapeHtml(x.ligne) + "</b>" +
        "<div style='margin-top:10px;font-size:13px;color:#617795;line-height:1.9;'>" +
        " " + x.rfq + " RFQ · " + x.offres + " offres (" + x.moy + "/RFQ)<br />" +
        " Prix médian : <b style='color:#1b2d49;'>" + (x.mediane ? formatEuro(x.mediane) : "—") + "</b><br />" +
        " Taux d'acceptation : <b style='color:#1b2d49;'>" + x.taux + " %</b>" +
        "</div></div>";
    }).join("");
  }

  /* ---------- Données de démonstration (back-office) ---------- */
  var donneurs = [
    { entreprise: "Industrie & Composants SAS", pays: "France", contact: "Karine Lopez", rfq: 34, affaires: 12, statut: "Actif" },
    { entreprise: "EuroParts BV", pays: "Belgique", contact: "Sophie Maes", rfq: 11, affaires: 5, statut: "Actif" },
    { entreprise: "Mediterraneo SL", pays: "Espagne", contact: "Marc Luna", rfq: 7, affaires: 2, statut: "Actif" },
    { entreprise: "FreshFood Italia SRL", pays: "Italie", contact: "Giulia Rossi", rfq: 2, affaires: 0, statut: "À vérifier" }
  ];

  var incidents = [
    { type: "Tentative de contournement", parties: "Transporteur T-003 ↔ client C0042", date: "12/09/2026", priorite: "Critique", statut: "En analyse", description: "Coordonnées détectées dans un message — filtre anti-contournement déclenché." },
    { type: "Transporteur ne confirme pas", parties: "Offre acceptée — T-0008", date: "10/09/2026", priorite: "Important", statut: "Action requise", description: "Offre acceptée il y a 48 h sans confirmation du transporteur — propose automatiquement l'offre de secours." },
    { type: "Document expiré", parties: "Assurance RC — Iberia Freight (T-006)", date: "08/09/2026", priorite: "Important", statut: "Ouvert", description: "Assurance arrivée à échéance — suspension manuelle à envisager." },
    { type: "Cotation erronée", parties: "RFQ-00032 — offre C", date: "05/09/2026", priorite: "Information", statut: "Résolu", description: "Frais de manutention oubliés — transporteur a corrigé son offre (horodatée)." }
  ];

  var contacts = [
    { entreprise: "Atlas Export SARL", pays: "Maroc", type: "Exportateur", contact: "Youssef Benali", fonction: "Responsable expédition", source: "Affaire TR-154", date: "14/07/2026" },
    { entreprise: "FreshFood Italia SRL", pays: "Italie", type: "Exportateur", contact: "Giulia Rossi", fonction: "Responsable export", source: "Inscription directe", date: "02/08/2026" },
    { entreprise: "Rheinland Spedition", pays: "Allemagne", type: "Transporteur", contact: "Stefan Weber", fonction: "Correspondant transport", source: "Contact fourni par opération", date: "22/08/2026" },
    { entreprise: "EuroParts BV", pays: "Belgique", type: "Importateur", contact: "Sophie Maes", fonction: "Responsable import", source: "Inscription directe", date: "15/06/2026" },
    { entreprise: "Iberia Freight", pays: "Espagne", type: "Transporteur", contact: "Carlos Ferrer", fonction: "Jefe de operaciones", source: "Affaire TR-171", date: "30/08/2026" }
  ];

  /* ---------- Init ---------- */
  renderKpis();
  renderTodo();
  renderAdminSelectRfq();
  renderDonneurs();
  renderCotations();
  renderIncidents();
  renderContacts();
  renderRapports();
  renderPays();
  renderVerif();
  renderAffaires();
  renderMetriques();

  var selAdmin = get("adminSelectRfq");
  if (selAdmin) selAdmin.addEventListener("change", renderClassement);
})();
