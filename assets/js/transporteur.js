/* ============================================================
   Transia — transporteur.html : compte, liste RFQ, réponse
   ============================================================ */
(function () {
  var DB = window.DB;

  function get(id) { return document.getElementById(id); }

  /* ---------- Compte transporteur ---------- */
  function renderCompte() {
    var compte = Store.get("compte", null);
    var panel = get("comptePanel");
    if (!compte) {
      panel.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap;">' +
        "<div><h3 class='mb-0'>Bienvenue dans l'espace transporteur</h3>" +
        "<p class='muted' style='font-size:14.5px;'>Créez votre compte en moins de 5 minutes pour consulter les demandes de cotation et y répondre.</p></div>" +
        '<button class="btn btn-primary btn-lg" id="btnOuvrirInscription">Créer mon compte</button></div>';
    } else {
      panel.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap;">' +
        '<div style="display:flex;gap:14px;align-items:center;">' +
        '<div class="avatar" style="width:52px;height:52px;font-size:18px;">' + initials(compte.raison) + "</div>" +
        "<div><h3 class='mb-0'>" + escapeHtml(compte.raison) + " " + badgeStatut(compte.statut) + "</h3>" +
        "<p class='muted' style='font-size:13.5px;margin:0;'>" +
        escapeHtml(compte.pays) + " · " + escapeHtml(compte.modes.join(" · ")) +
        " · Immat. " + escapeHtml(compte.immat) + "</p></div></div>" +
        '<a href="admin.html" class="btn btn-outline btn-sm">Suivre ma vérification →</a></div>' +
        (compte.statut === "À VÉRIFIER"
          ? '<div class="info-banner" style="margin-top:16px;">🛡️ <span>Votre compte est <b>à vérifier</b> : l\'administrateur contrôle vos justificatifs (immatriculation, licences, assurances) et garde la décision finale d\'activation.</span></div>'
          : "");
    }
    var btn = get("btnOuvrirInscription");
    if (btn) btn.addEventListener("click", function () { openModal("modalInscription"); });
  }
  renderCompte();

  /* ---------- Listes défilantes : pays + devises ---------- */
  var REF = window.REF || { pays: [], devises: [] };

  var dlPaysT = get("dlPaysT");
  if (dlPaysT) {
    REF.pays.forEach(function (p) {
      var o = document.createElement("option");
      o.value = p.n;
      dlPaysT.appendChild(o);
    });
  }

  var rDevise = get("rDevise");
  if (rDevise) {
    REF.devises.forEach(function (d) {
      var o = document.createElement("option");
      o.value = d.c;
      o.textContent = d.c + " — " + d.n;
      rDevise.appendChild(o);
    });
    rDevise.value = "EUR";
  }

  /* ---------- Modale inscription ---------- */
  var modesBox = get("iModes");
  DB.modes.forEach(function (m) {
    var label = document.createElement("label");
    label.style.cssText = "display:flex;gap:7px;align-items:center;font-size:14px;font-weight:500;";
    label.innerHTML = '<input type="checkbox" name="iMode" value="' + m + '" style="width:auto;" /> ' + m;
    modesBox.appendChild(label);
  });

  get("btnInscrire").addEventListener("click", function () {
    var ids = ["iRaison", "iPays", "iImmat", "iTva", "iAdresse", "iNom", "iTel", "iEmail"];
    var ok = true;
    ids.forEach(function (id) { if (!required(get(id))) ok = false; });

    var modes = [];
    document.querySelectorAll('input[name="iMode"]:checked').forEach(function (c) { modes.push(c.value); });
    if (!modes.length) { toast("Sélectionnez au moins un mode de transport.", "err"); ok = false; }
    if (!ok) { toast("Merci de compléter les champs obligatoires.", "err"); return; }

    Store.set("compte", {
      raison: get("iRaison").value.trim(),
      pays: get("iPays").value.trim(),
      immat: get("iImmat").value.trim(),
      tva: get("iTva").value.trim(),
      adresse: get("iAdresse").value.trim(),
      site: get("iSite").value.trim(),
      nom: get("iNom").value.trim(),
      fonction: get("iFonction").value.trim() || "—",
      tel: get("iTel").value.trim(),
      email: get("iEmail").value.trim(),
      modes: modes,
      lignes: get("iLignes").value.trim() || "—",
      statut: "À VÉRIFIER",
      cree: nowFr()
    });
    closeModal("modalInscription");
    renderCompte();
    toast("Compte créé — statut : à vérifier.", "ok");
  });

  /* ---------- Filtres ---------- */
  var fDepart = get("fDepart"), fArrivee = get("fArrivee"), fMode = get("fMode"), fType = get("fType");

  function fillSelect(sel, values) {
    values.sort().forEach(function (v) {
      var o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
    });
  }
  var rfqs = getAllRfqs();
  fillSelect(fDepart, rfqs.map(function (r) { return r.origine.pays; }).filter(function (v, i, a) { return a.indexOf(v) === i; }));
  fillSelect(fArrivee, rfqs.map(function (r) { return r.dest.pays; }).filter(function (v, i, a) { return a.indexOf(v) === i; }));
  fillSelect(fMode, DB.modes.slice());
  fillSelect(fType, rfqs.map(function (r) { return r.marchandise.type; }).filter(function (v, i, a) { return a.indexOf(v) === i; }));

  /* ---------- Table des RFQ ---------- */
  function renderTable() {
    var body = get("rfqBody");
    var list = rfqs.filter(function (r) {
      return (!fDepart.value || r.origine.pays === fDepart.value) &&
             (!fArrivee.value || r.dest.pays === fArrivee.value) &&
             (!fMode.value || r.mode === fMode.value) &&
             (!fType.value || r.marchandise.type === fType.value);
    });
    body.innerHTML = "";
    get("countRfq").textContent = list.length;
    get("emptyState").classList.toggle("hidden", list.length > 0);
    get("rfqTable").classList.toggle("hidden", list.length === 0);

    list.forEach(function (r) {
      var tr = document.createElement("tr");
      var repondue = getOffres(r.ref).some(function (o) { return o.source === "user"; });
      tr.innerHTML =
        "<td><b>" + escapeHtml(r.ref) + "</b></td>" +
        "<td>" + escapeHtml(r.origine.ville) + "<br /><span class='muted' style='font-size:12px;'>" + escapeHtml(r.origine.pays) + "</span></td>" +
        "<td>" + escapeHtml(r.dest.ville) + "<br /><span class='muted' style='font-size:12px;'>" + escapeHtml(r.dest.pays) + "</span></td>" +
        "<td><span class='mode-badge'>" + modeIcon(r.mode) + " " + escapeHtml(r.mode) + "</span></td>" +
        "<td>" + escapeHtml(r.marchandise.type) + (r.dangereuse ? " ⚠️" : "") +
        "<br /><span class='muted' style='font-size:12px;'>" + escapeHtml(String(r.marchandise.poids)) + "</span></td>" +
        "<td>" + escapeHtml(r.origine.date) + "</td>" +
        "<td>" + badgeStatut(r.statut) + "</td>" +
        "<td>" + (repondue
          ? "<span class='badge badge-green'>Offre déposée</span>"
          : "<button class='btn btn-primary btn-sm' data-ref='" + escapeHtml(r.ref) + "'>Répondre</button>") +
        "</td>";
      body.appendChild(tr);
    });

    body.querySelectorAll("button[data-ref]").forEach(function (b) {
      b.addEventListener("click", function () { ouvrirReponse(b.getAttribute("data-ref")); });
    });
  }

  [fDepart, fArrivee, fMode, fType].forEach(function (s) { s.addEventListener("change", renderTable); });
  get("btnReset").addEventListener("click", function () {
    fDepart.value = ""; fArrivee.value = ""; fMode.value = ""; fType.value = "";
    renderTable();
  });

  /* ---------- Modale réponse ---------- */
  var refCourante = null;
  function ouvrirReponse(ref) {
    if (!Store.get("compte", null)) {
      toast("Créez d'abord votre compte transporteur.", "err");
      openModal("modalInscription");
      return;
    }
    var r = findRfq(ref);
    if (!r) return;
    refCourante = ref;
    get("reponseRef").textContent = ref + " — " + r.mode;
    get("reponseInfo").innerHTML =
      "<b>" + escapeHtml(r.origine.ville) + " (" + escapeHtml(r.origine.pays) + ") → " +
      escapeHtml(r.dest.ville) + " (" + escapeHtml(r.dest.pays) + ")</b><br />" +
      escapeHtml(String(r.marchandise.desc)) + " · " + escapeHtml(String(r.marchandise.poids)) +
      " · " + escapeHtml(String(r.marchandise.volume)) + "<br />" +
      "Incoterm " + escapeHtml(r.incoterm) + " · enlèvement le " + escapeHtml(r.origine.date) +
      (r.dangereuse ? "<br /><b style='color:#96650f;'>⚠️ Marchandise dangereuse : " + escapeHtml(r.dangerInfo.onu + " — " + r.dangerInfo.classe) + "</b>" : "");
    openModal("modalReponse");
  }

  get("btnEnvoyerOffre").addEventListener("click", function () {
    var ok = required(get("rPrix")) & required(get("rDelai")) & required(get("rValidite"));
    if (!ok) { toast("Prix, délai et validité sont obligatoires.", "err"); return; }
    if (!refCourante) return;

    var r = findRfq(refCourante);
    var existantes = getOffres(refCourante);
    var lettre = String.fromCharCode(65 + existantes.length);

    var v = get("rValidite").value;
    saveOffre(refCourante, {
      lettre: lettre,
      prix: Number(get("rPrix").value),
      devise: get("rDevise").value,
      delai: get("rDelai").value.trim(),
      validite: v ? v.split("-").reverse().join("/") : "—",
      conditions: get("rConditions").value.trim() || "—",
      services: get("rFrais").value.trim() || "—",
      conforme: true,
      source: "user",
      dateDepot: nowFr(),
      qualite: {
        statut: "Transporteur vérifié",
        note: "Nouveau sur la plateforme",
        licence: Store.get("compte", {}).immat || "—",
        experience: "Compte créé le " + Store.get("compte", {}).cree,
        affaires: "0 affaire sur la plateforme"
      }
    });

    closeModal("modalReponse");
    ["rPrix", "rDelai", "rValidite", "rConditions", "rFrais"].forEach(function (id) { get(id).value = ""; });
    toast("Offre " + lettre + " déposée pour " + refCourante + " — à l'aveugle, comme toutes les autres.", "ok");
    renderTable();
    renderMesOffres();
    if (r) r.reponses = (r.reponses || 0) + 1;
  });

  /* ---------- Mes offres ---------- */
  function renderMesOffres() {
    var zone = get("mesOffres");
    var all = Store.get("offres", {});
    var refs = Object.keys(all);
    zone.innerHTML = "";
    if (!refs.length) {
      zone.innerHTML = "<p class='muted' style='font-size:13.5px;'>Aucune offre déposée pour l'instant. Cliquez sur « Répondre » à côté d'une demande.</p>";
      return;
    }
    refs.forEach(function (ref) {
      all[ref].forEach(function (o) {
        var r = findRfq(ref);
        var div = document.createElement("div");
        div.style.cssText = "border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px;";
        div.innerHTML =
          "<div style='display:flex;justify-content:space-between;align-items:center;gap:8px;'>" +
          "<b style='color:#0f2c4e;'>" + escapeHtml(ref) + "</b>" +
          "<span class='badge badge-amber'>En attente d'analyse</span></div>" +
          "<div style='font-size:13px;color:#617795;margin-top:4px;'>" +
          (r ? escapeHtml(r.origine.ville) + " → " + escapeHtml(r.dest.ville) + " · " : "") +
          "<b style='color:#1b2d49;'>" + formatEuro(o.prix) + "</b> · délai " + escapeHtml(o.delai) + "</div>" +
          "<div style='font-size:12px;color:#9fb2cc;margin-top:4px;'>Déposée le " + escapeHtml(o.dateDepot || "—") + " · Offre " + escapeHtml(o.lettre) + "</div>";
        zone.appendChild(div);
      });
    });
  }

  renderTable();
  renderMesOffres();
})();
