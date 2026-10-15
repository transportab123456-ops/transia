/* ============================================================
   Transia — comparateur.html : comparaison, recommandation,
   acceptation / refus, confirmation + commission 8 %
   ============================================================ */
(function () {
  var DB = window.DB;
  function get(id) { return document.getElementById(id); }

  var COMMISSION = 0.08;

  /* ---------- Sélection de la RFQ ---------- */
  var select = get("selectRfq");
  var rfqs = getAllRfqs();
  rfqs.forEach(function (r) {
    var o = document.createElement("option");
    o.value = r.ref;
    o.textContent = r.ref + " — " + r.origine.ville + " → " + r.dest.ville + " (" + r.mode + ")";
    select.appendChild(o);
  });

  var params = new URLSearchParams(window.location.search);
  var preselect = params.get("ref");
  if (preselect && findRfq(preselect)) select.value = preselect;

  /* ---------- Statuts locaux ---------- */
  function getConfirmees() { return Store.get("confirmees", {}); }
  function getRefusees() { return Store.get("refus", []); }

  /* ---------- Choix d'une identité transporteur (démo) ---------- */
  function choisirTransporteur(rfq) {
    var cibles = DB.transporteurs.filter(function (t) {
      return t.statut === "ACTIF" && t.modes.indexOf(rfq.mode) !== -1;
    });
    if (!cibles.length) cibles = DB.transporteurs.filter(function (t) { return t.statut === "ACTIF"; });
    if (!cibles.length) cibles = DB.transporteurs;
    var h = 0;
    for (var i = 0; i < rfq.ref.length; i++) h += rfq.ref.charCodeAt(i);
    return cibles[h % cibles.length];
  }

  /* ---------- Génération d'offres de démonstration ---------- */
  function genererOffres(rfq) {
    var base = { "Routier": 2200, "Maritime": 3700, "Aérien": 1850, "Multimodal": 2600 }[rfq.mode] || 2000;
    var delais = { "Routier": ["5 jours", "6 jours", "4 jours"], "Maritime": ["7 jours", "6 jours", "9 jours"], "Aérien": ["48 h", "72 h"], "Multimodal": ["6 jours", "8 jours"] }[rfq.mode] || ["6 jours"];
    var noms = ["TransAtlas Logistics", "EuroBridge Transport", "Maghreb Express", "Alpina Trans"];
    var variantes = [-0.11, -0.05, 0.04, 0.09];
    var start = getOffres(rfq.ref).length;
    var out = [];
    for (var i = 0; i < 4; i++) {
      var prix = Math.round((base * (1 + variantes[i])) / 10) * 10;
      out.push({
        lettre: String.fromCharCode(65 + start + i),
        prix: prix,
        devise: "EUR",
        delai: delais[i % delais.length],
        validite: "30/09/2026",
        conditions: i === 3 ? "Hors manutention à l'arrivée — périmètre non comparable." : "Port payé. TVA incluse. Assurance standard incluse.",
        services: i === 0 ? "Groupage hebdomadaire, suivi inclus" : "—",
        conforme: i !== 3,
        motifNonConformite: i === 3 ? "Périmètre différent : manutention d'arrivée exclue. Offre écartée de la recommandation." : null,
        source: "simu",
        dateDepot: nowFr(),
        qualite: {
          statut: "Transporteur vérifié",
          note: ["4,6 / 5", "4,3 / 5", "4,7 / 5", "4,5 / 5"][i],
          licence: "Licence communautaire active",
          experience: [9, 6, 11, 8][i] + " ans d'activité",
          affaires: [210, 145, 305, 175][i] + " affaires sur la plateforme"
        },
        nomDemo: noms[i]
      });
    }
    out.forEach(function (o) { saveOffre(rfq.ref, o); });
    return out;
  }

  /* ---------- Rendu ---------- */
  var refCourante = null;

  function rendre() {
    var ref = select.value;
    refCourante = ref;
    var rfq = findRfq(ref);
    if (!rfq) return;

    var offres = getOffres(ref);
    var confirmees = getConfirmees();
    var refusees = getRefusees();
    var refusee = refusees.filter(function (r) { return r.ref === ref; })[0];
    var affaire = confirmees[ref] || getAffaires().filter(function (a) { return a.ref === ref; })[0] || null;
    /* RFQ déjà confirmée dans les données initiales */
    if (!affaire && rfq.statut === "CONFIRMÉE" && rfq.prixRetenu) {
      affaire = {
        ref: rfq.ref,
        ligne: rfq.origine.ville + " → " + rfq.dest.ville,
        mode: rfq.mode,
        offre: "A",
        prix: rfq.prixRetenu,
        devise: "EUR",
        commission: Math.round(rfq.prixRetenu * COMMISSION),
        date: "14/07/2026 à 11:42",
        transporteur: {
          id: "T-001",
          nom: "TransAtlas Logistics",
          contact: "Sophie Marchand",
          fonction: "Responsable commercial",
          tel: "+33 4 72 00 11 22",
          email: "smarchand@transatlas-logistics.example"
        }
      };
    }

    /* Résumé RFQ */
    get("rfqResume").innerHTML =
      "<b style='color:#0f2c4e;'>" + escapeHtml(rfq.origine.ville) + " (" + escapeHtml(rfq.origine.pays) + ") → " +
      escapeHtml(rfq.dest.ville) + " (" + escapeHtml(rfq.dest.pays) + ")</b> · " +
      escapeHtml(rfq.mode) + " · " + escapeHtml(rfq.marchandise.type) + " · " + escapeHtml(String(rfq.marchandise.poids)) +
      "<br />Incoterm " + escapeHtml(rfq.incoterm) + " · enlèvement " + escapeHtml(rfq.origine.date) +
      " · " + badgeStatut(affaire ? "CONFIRMÉE" : (refusee ? "CLOTURÉE" : rfq.statut));

    /* Sans offre */
    get("offersEmpty").classList.toggle("hidden", offres.length > 0);
    get("offersWrap").classList.toggle("hidden", offres.length === 0);

    if (offres.length === 0) {
      rendreReco(rfq, null, affaire, refusee);
      return;
    }

    /* Tableau des offres, trié par prix */
    var triees = offres.slice().sort(function (a, b) { return a.prix - b.prix; });
    var conformes = triees.filter(function (o) { return o.conforme; });
    var reco = conformes[0] || null;

    get("countOffres").textContent = offres.length;
    var body = get("offresBody");
    body.innerHTML = "";
    triees.forEach(function (o) {
      var tr = document.createElement("tr");
      if (reco && o.lettre === reco.lettre && !affaire) tr.style.background = "var(--blue-light)";
      tr.innerHTML =
        "<td><b>Offre " + escapeHtml(o.lettre) + "</b>" +
        (reco && o.lettre === reco.lettre && !affaire ? " <span class='badge badge-green'>Recommandée</span>" : "") + "</td>" +
        "<td><b>" + formatEuro(o.prix) + "</b> " + escapeHtml(o.devise) + "</td>" +
        "<td>" + escapeHtml(o.delai) + "</td>" +
        "<td>" + escapeHtml(o.validite) + "</td>" +
        "<td style='font-size:13px;'>" + escapeHtml(o.conditions) + "</td>" +
        "<td>" + (o.conforme
          ? "<span class='badge badge-green'>Conforme</span>"
          : "<span class='badge badge-red'>Non comparable</span>") + "</td>";
      body.appendChild(tr);
    });

    var nonConf = triees.filter(function (o) { return !o.conforme; });
    var note = get("nonConformNote");
    if (nonConf.length) {
      note.classList.remove("hidden");
      note.innerHTML = "⚖️ <span><b>Contrôle de périmètre :</b> " +
        nonConf.map(function (o) { return "Offre " + escapeHtml(o.lettre) + " — " + escapeHtml(o.motifNonConformite || "périmètre différent"); }).join(" · ") +
        "</span>";
    } else {
      note.classList.add("hidden");
    }

    rendreReco(rfq, reco, affaire, refusee);
  }

  /* ---------- Panneau recommandation ---------- */
  function rendreReco(rfq, reco, affaire, refusee) {
    var box = get("recoBox");

    /* Affaire confirmée : dévoilement */
    if (affaire) {
      var t = affaire.transporteur;
      box.innerHTML =
        "<h3 class='mt-0'>✅ Affaire confirmée</h3>" +
        "<p style='font-size:13.5px;color:#617795;'>Horodatée le " + escapeHtml(affaire.date) + " · réf. " + escapeHtml(affaire.ref) + "</p>" +
        "<div class='divider'></div>" +
        "<div class='track-summary' style='grid-template-columns:1fr 1fr;'>" +
        "<div class='box'><span>Prix accepté</span><b>" + formatEuro(affaire.prix) + " " + escapeHtml(affaire.devise) + "</b></div>" +
        "<div class='box'><span>Commission 8 %</span><b>" + formatEuro(affaire.commission) + "</b></div>" +
        "</div>" +
        "<p style='font-size:12.5px;color:#617795;'>Assiette : la partie transport de l'opération. Facturée au transporteur. Les prestations annexes hors transport sont exclues de l'assiette.</p>" +
        "<div class='divider'></div>" +
        "<h4 style='color:#0f2c4e;margin-bottom:12px;'>🔓 Identités dévoilées</h4>" +
        "<div style='border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:10px;'>" +
        "<b style='color:#0f2c4e;'>" + escapeHtml(t.nom) + "</b> <span class='badge badge-green'>Transporteur</span>" +
        "<p style='font-size:13px;color:#617795;margin-top:6px;'>" + escapeHtml(t.contact) + " — " + escapeHtml(t.fonction) + "<br />" +
        escapeHtml(t.tel) + " · " + escapeHtml(t.email) + "</p></div>" +
        "<div style='border:1px solid var(--line);border-radius:10px;padding:14px;'>" +
        "<b style='color:#0f2c4e;'>" + escapeHtml(rfq.contact ? rfq.contact.entreprise || "Donneur d'ordre" : "Industrie & Composants SAS") + "</b> <span class='badge badge-blue'>Donneur d'ordre</span>" +
        "<p style='font-size:13px;color:#617795;margin-top:6px;'>" +
        escapeHtml(rfq.contact ? rfq.contact.nom + " — " + rfq.contact.fonction : "Karine Lopez — Responsable import") + "<br />" +
        escapeHtml(rfq.contact ? rfq.contact.tel + " · " + rfq.contact.email : "+33 1 44 55 66 77 · k.lopez@iec-sas.example") + "</p></div>" +
        "<p style='font-size:12.5px;color:#617795;margin-top:12px;'>Contrat de transport conclu directement entre les parties. Les échanges passent désormais hors plateforme, sous clause de non-contournement.</p>" +
        "<a href='admin.html' class='btn btn-outline btn-block' style='margin-top:12px;'>Voir dans le journal des affaires →</a>";
      return;
    }

    /* Refus enregistré */
    if (refusee) {
      box.innerHTML =
        "<h3 class='mt-0'>❌ Offre refusée</h3>" +
        "<p style='font-size:14px;color:#617795;'>Motif : <b>" + escapeHtml(refusee.motif) + "</b></p>" +
        "<p style='font-size:13px;color:#617795;'>Enregistré le " + escapeHtml(refusee.date) + " — utilisé pour l'analyse commerciale.</p>" +
        "<div class='divider'></div>" +
        "<p style='font-size:13.5px;color:#617795;'>La demande peut rester ouverte aux autres transporteurs, ou être clôturée.</p>" +
        "<a href='demande.html' class='btn btn-primary btn-block' style='margin-top:12px;'>Déposer une nouvelle demande</a>";
      return;
    }

    /* Pas encore d'offres */
    if (!reco) {
      box.innerHTML =
        "<h3 class='mt-0'>⏳ En attente d'offres</h3>" +
        "<p style='font-size:14px;color:#617795;'>Dès qu'au moins une offre conforme sera reçue, la plateforme recommandera la meilleure : prix + conformité + délai.</p>" +
        "<div class='divider'></div>" +
        "<p style='font-size:13px;color:#617795;'>Rappel : les transporteurs cotent à l'aveugle — le nombre d'offres n'est jamais communiqué.</p>";
      return;
    }

    /* Offre recommandée */
    box.innerHTML =
      "<h3 class='mt-0'>🏆 Offre recommandée</h3>" +
      "<p style='font-size:13px;color:#617795;'>La moins chère parmi les offres couvrant le même périmètre.</p>" +
      "<div style='background:var(--blue-light);border-radius:12px;padding:18px;margin:14px 0;'>" +
      "<div class='price-tag' style='text-align:left;'><b style='font-size:32px;'>" + formatEuro(reco.prix) + "</b>" +
      "<span>" + escapeHtml(reco.devise) + " · transport seul</span></div>" +
      "<div style='display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:13.5px;color:#617795;'>" +
      "<span>⏱️ Délai : <b style='color:#1b2d49;'>" + escapeHtml(reco.delai) + "</b></span>" +
      "<span>📅 Validité : <b style='color:#1b2d49;'>" + escapeHtml(reco.validite) + "</b></span>" +
      "<span>Offre <b style='color:#1b2d49;'>" + escapeHtml(reco.lettre) + "</b></span>" +
      "</div></div>" +
      "<h4 style='color:#0f2c4e;font-size:14.5px;margin-bottom:8px;'>Conditions importantes</h4>" +
      "<p style='font-size:13.5px;color:#617795;margin-bottom:6px;'>" + escapeHtml(reco.conditions) + "</p>" +
      "<p style='font-size:13.5px;color:#617795;'><b>Services :</b> " + escapeHtml(reco.services || "—") + "</p>" +
      "<div class='divider'></div>" +
      "<h4 style='color:#0f2c4e;font-size:14.5px;margin-bottom:10px;'>Qualification du transporteur</h4>" +
      "<ul style='list-style:none;font-size:13px;color:#617795;line-height:1.9;'>" +
      "<li>🛡️ " + escapeHtml(reco.qualite.statut) + "</li>" +
      "<li>⭐ Note " + escapeHtml(reco.qualite.note) + "</li>" +
      "<li>📄 " + escapeHtml(reco.qualite.licence) + "</li>" +
      "<li>🗓️ " + escapeHtml(reco.qualite.experience) + "</li>" +
      "<li>📈 " + escapeHtml(reco.qualite.affaires) + "</li>" +
      "</ul>" +
      "<div class='info-banner' style='margin:14px 0;'>🔒 <span>L'identité et les coordonnées du transporteur seront révélées <b>uniquement après votre acceptation</b>.</span></div>" +
      "<button class='btn btn-primary btn-block btn-lg' id='btnAccepter'>Accepter l'offre</button>" +
      "<button class='btn btn-outline btn-block' id='btnRefuser' style='margin-top:10px;'>Refuser l'offre</button>";

    get("btnAccepter").addEventListener("click", function () { accepter(rfq, reco); });
    get("btnRefuser").addEventListener("click", function () { ouvrirRefus(rfq, reco); });
  }

  /* ---------- Acceptation ---------- */
  function accepter(rfq, reco) {
    var t = choisirTransporteur(rfq);
    var commission = Math.round(reco.prix * COMMISSION);
    var affaire = {
      ref: rfq.ref,
      ligne: rfq.origine.ville + " → " + rfq.dest.ville,
      mode: rfq.mode,
      offre: reco.lettre,
      prix: reco.prix,
      devise: reco.devise,
      commission: commission,
      date: nowFr(),
      transporteur: {
        id: t.id,
        nom: t.nom,
        contact: t.contact,
        fonction: t.fonction,
        tel: t.tel,
        email: t.email
      }
    };
    var conf = getConfirmees();
    conf[rfq.ref] = affaire;
    Store.set("confirmees", conf);
    saveAffaire(affaire);
    rendre();
    toast("Affaire confirmée — identités dévoilées, commission de " + formatEuro(commission) + " enregistrée.", "ok");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ---------- Refus ---------- */
  var refusEnCours = null;
  var motifsBox = get("motifsList");
  DB.motifsRefus.forEach(function (m, i) {
    var label = document.createElement("label");
    label.style.cssText = "display:flex;gap:9px;align-items:center;font-size:14.5px;font-weight:500;cursor:pointer;";
    label.innerHTML = "<input type='radio' name='motif' value='" + escapeHtml(m) + "' style='width:auto;' /> " + escapeHtml(m);
    motifsBox.appendChild(label);
  });
  motifsBox.addEventListener("change", function (e) {
    get("autreField").style.display = e.target.value === "Autre" ? "block" : "none";
  });

  function ouvrirRefus(rfq, reco) {
    refusEnCours = { rfq: rfq, reco: reco };
    openModal("modalRefus");
  }

  get("btnConfirmerRefus").addEventListener("click", function () {
    var choisi = document.querySelector('input[name="motif"]:checked');
    if (!choisi) { toast("Sélectionnez un motif de refus.", "err"); return; }
    var motif = choisi.value === "Autre" ? ("Autre — " + (get("refusAutre").value.trim() || "non précisé")) : choisi.value;
    var liste = getRefusees();
    liste.push({ ref: refusEnCours.rfq.ref, motif: motif, date: nowFr() });
    Store.set("refus", liste);
    closeModal("modalRefus");
    document.querySelectorAll('input[name="motif"]').forEach(function (r) { r.checked = false; });
    get("autreField").style.display = "none";
    get("refusAutre").value = "";
    rendre();
    toast("Refus enregistré — merci, ce motif alimente l'analyse commerciale.", "ok");
  });

  /* ---------- Actions ---------- */
  select.addEventListener("change", rendre);
  get("btnSimuler").addEventListener("click", function () {
    var rfq = findRfq(select.value);
    if (!rfq) return;
    genererOffres(rfq);
    rendre();
    toast("4 offres de démonstration déposées — comparaison disponible.", "ok");
  });

  rendre();
})();
