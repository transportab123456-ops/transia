/* ============================================================
   Transia — comparateur.html : comparaison, recommandation,
   acceptation / refus, confirmation + commission (barème dégressif)
   ============================================================ */
(function () {
  var DB = window.DB;
  function get(id) { return document.getElementById(id); }

  var Commission = window.Commission;
  var DEVISE_RFQ = Moteur.DEVISE_RFQ;

  /* Les fonctions du moteur (conversion, normalisation, classement, validation)
     sont partagées via assets/js/moteur.js — voir Moteur.* */

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
    var delais = { "Routier": ["5 jours", "6 jours", "4 jours", "8 jours"], "Maritime": ["7 jours", "6 jours", "9 jours", "12 jours"], "Aérien": ["48 h", "72 h", "48 h", "96 h"], "Multimodal": ["6 jours", "8 jours", "5 jours", "11 jours"] }[rfq.mode] || ["6 jours"];
    var delaiJours = { "Routier": [5, 6, 4, 8], "Maritime": [7, 6, 9, 12], "Aérien": [2, 3, 2, 4], "Multimodal": [6, 8, 5, 11] }[rfq.mode] || [6];
    var noms = ["TransAtlas Logistics", "EuroBridge Transport", "Maghreb Express", "Alpina Trans"];
    /* Variantes de prix TRANSPORT (avant frais obligatoires) :
       l'offre C (non conforme) est volontairement la MOINS CHÈRE pour illustrer
       la règle du moteur : le prix bas ne gagne pas s'il n'est pas comparable. */
    var variantes = [-0.02, -0.05, -0.11, 0.09];
    var start = getOffres(rfq.ref).length;
    var out = [];
    for (var i = 0; i < 4; i++) {
      var prix = Math.round((base * (1 + variantes[i])) / 10) * 10;
      var offre = {
        lettre: String.fromCharCode(65 + start + i),
        prix: prix,
        devise: "EUR",
        fraisObligatoires: 0,
        fraisAPreciser: false,
        delai: delais[i % delais.length],
        delaiJours: delaiJours[i % delaiJours.length],
        validite: "30/09/2026",
        conditions: "Port payé. TVA incluse. Assurance standard incluse.",
        services: i === 0 ? "Groupage hebdomadaire, suivi inclus" : "—",
        conforme: true,
        motifNonConformite: null,
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
      };

      /* Exercice du moteur — cas particuliers pour tester la normalisation */
      if (i === 1) {
        /* Offre B : frais obligatoires NON précisés → À VÉRIFIER */
        offre.fraisAPreciser = true;
        offre.conditions = "Frais de passage et de manutention à ajouter (montant non précisé).";
        offre.services = "—";
      } else if (i === 2) {
        /* Offre C : périmètre différent (livraison déchargée exclue) → NON CONFORME */
        offre.motifNonConformite = "Périmètre différent : manutention d'arrivée exclue. Offre écartée de la recommandation.";
        offre.conditions = "Hors manutention à l'arrivée — périmètre non comparable.";
      } else if (i === 3) {
        /* Offre D : transport en USD + frais obligatoires explicites → conversion + normalisation */
        offre.devise = "USD";
        offre.prix = Math.round(prix / 0.92); /* prix exprimé en USD */
        offre.fraisObligatoires = 140; /* frais obligatoires (même devise) */
        offre.conditions = "Port payé. Frais de dossier obligatoires 140 USD. TVA incluse.";
      }

      out.push(offre);
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
        commission: Commission.calculer(rfq.prixRetenu).commission,
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

    /* Tableau des offres — normalisées et classées par le moteur */
    var classement = Moteur.classer(offres);
    var ordonnees = classement.conforme.concat(classement.aVerifier, classement.ecartees);
    var reco = classement.recommandee;
    var validee = Moteur.estValidee(ref);

    get("countOffres").textContent = offres.length;
    var body = get("offresBody");
    body.innerHTML = "";
    ordonnees.forEach(function (o) {
      var tr = document.createElement("tr");
      var estReco = reco && o.lettre === reco.lettre;
      if (estReco && !affaire) tr.style.background = "var(--blue-light)";

      var badgeStatutOffre;
      if (o.statutTechnique === "NON_CONFORME") badgeStatutOffre = "<span class='badge badge-red'>Non conforme</span>";
      else if (o.statutTechnique === "A_VERIFIER") badgeStatutOffre = "<span class='badge badge-amber'>À vérifier</span>";
      else badgeStatutOffre = "<span class='badge badge-green'>Conforme</span>";

      var prixAffiche = o.prixComparable == null
        ? "<span style='color:#96650f;'>à déterminer</span>"
        : "<b>" + formatEuro(o.prixComparable) + "</b> <span style='font-size:11.5px;color:#9fb2cc;'>" + escapeHtml(DEVISE_RFQ) + "</span>";

      /* détail de la normalisation sous le prix */
      var detail = o.prixComparable == null ? "frais obligatoires non précisés"
        : (o.fraisObligatoires > 0 || o.devise !== "EUR"
            ? "transport " + formatEuro(o.transportComparaison) + (o.fraisObligatoires > 0 ? " + frais " + formatEuro(o.fraisComparaison) : "") + (o.devise !== "EUR" ? " · conv. " + o.tauxChange : "")
            : "tout compris");

      tr.innerHTML =
        "<td><b>Offre " + escapeHtml(o.lettre) + "</b>" +
        (estReco && !affaire ? " <span class='badge badge-blue'>Recommandée</span>" : "") +
        "<br /><span style='font-size:11.5px;color:#9fb2cc;'>" + escapeHtml(o.devise) + " origine</span></td>" +
        "<td>" + prixAffiche + "<br /><span style='font-size:11.5px;color:#9fb2cc;'>" + detail + "</span></td>" +
        "<td>" + escapeHtml(o.delai) + "</td>" +
        "<td>" + escapeHtml(o.validite) + "</td>" +
        "<td style='font-size:13px;'>" + escapeHtml(o.conditions) + "</td>" +
        "<td>" + badgeStatutOffre + "</td>";
      body.appendChild(tr);
    });

    /* Note d'exclusion / clarification */
    var note = get("nonConformNote");
    var messages = [];
    if (classement.ecartees.length) {
      messages.push("⚖️ <span><b>Offres écartées :</b> " +
        classement.ecartees.map(function (o) { return "Offre " + escapeHtml(o.lettre) + " — " + escapeHtml(o.motifNonConformite || "périmètre différent"); }).join(" · ") + "</span>");
    }
    if (classement.aVerifier.length) {
      messages.push("🔎 <span><b>À clarifier :</b> " +
        classement.aVerifier.map(function (o) { return "Offre " + escapeHtml(o.lettre) + " — frais obligatoires à préciser"; }).join(" · ") + "</span>");
    }
    if (messages.length) {
      note.classList.remove("hidden");
      note.innerHTML = messages.join("<br />");
    } else {
      note.classList.add("hidden");
    }

    rendreReco(rfq, reco, affaire, refusee, classement, validee);
  }

  /* ---------- Panneau recommandation ---------- */
  function rendreReco(rfq, reco, affaire, refusee, classement, validee) {
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
        "<div class='box'><span>Commission (barème)</span><b>" + formatEuro(affaire.commission) + "</b></div>" +
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
    var secoursHtml = "";
    if (classement && classement.secours.length) {
      secoursHtml = "<div class='divider'></div><h4 style='color:#0f2c4e;font-size:14px;margin-bottom:8px;'>🛟 Offres de secours (internes)</h4>" +
        "<p style='font-size:12.5px;color:#9fb2cc;margin-bottom:8px;'>Si le transporteur n°1 ne confirme pas, la suivante est proposée sans relancer l'appel d'offres.</p>" +
        classement.secours.map(function (s, idx) {
          return "<div style='display:flex;justify-content:space-between;font-size:13px;color:#617795;padding:6px 0;border-bottom:1px dashed var(--line);'>" +
            "<span>Secours n°" + (idx + 1) + " — Offre " + escapeHtml(s.lettre) + "</span>" +
            "<b>" + formatEuro(s.prixComparable) + "</b></div>";
        }).join("");
    }

    var assiette = reco.assietteCommission;
    var commission = Commission.calculer(assiette).commission;

    /* Gate : l'algorithme propose, l'administrateur valide avant envoi au client */
    if (!validee) {
      box.innerHTML =
        "<h3 class='mt-0'>🏆 Offre recommandée par le moteur</h3>" +
        "<p style='font-size:13px;color:#617795;'>Meilleur prix comparable parmi les offres conformes et de même périmètre.</p>" +
        "<div style='background:var(--blue-light);border-radius:12px;padding:18px;margin:14px 0;'>" +
        "<div class='price-tag' style='text-align:left;'><b style='font-size:32px;'>" + formatEuro(reco.prixComparable) + "</b>" +
        "<span>prix comparable (transport + frais obligatoires) en " + escapeHtml(DEVISE_RFQ) + "</span></div>" +
        "<div style='display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:13.5px;color:#617795;'>" +
        "<span>⏱️ <b style='color:#1b2d49;'>" + escapeHtml(reco.delai) + "</b></span>" +
        "<span>📅 Validité <b style='color:#1b2d49;'>" + escapeHtml(reco.validite) + "</b></span>" +
        "<span>Offre <b style='color:#1b2d49;'>" + escapeHtml(reco.lettre) + "</b></span></div></div>" +
        "<div class='info-banner' style='margin:14px 0;'>🧮 <span><b>Normalisation appliquée :</b> prix comparable = transport + frais obligatoires (options exclues), converti en " + escapeHtml(DEVISE_RFQ) + ". L'assiette de commission reste la seule partie transport.</span></div>" +
        secoursHtml +
        "<div class='divider'></div>" +
        "<div class='info-banner' style='margin:14px 0;'>🛡️ <span><b>Validation administrateur requise.</b> L'algorithme propose — l'administrateur contrôle avant que l'offre ne vous soit présentée pour acceptation.</span></div>" +
        "<a href='admin.html#comparateur' class='btn btn-primary btn-block btn-lg'>Valider côté administration</a>" +
        "<p class='form-note text-center'>Aucune offre n'est envoyée automatiquement au client au lancement.</p>";
      return;
    }

    var valInfo = Moteur.getValidations()[rfq.ref];
    box.innerHTML =
      "<h3 class='mt-0'>🏆 Offre recommandée</h3>" +
      "<p style='font-size:13px;color:#617795;'>Validée par l'administrateur le " + escapeHtml(valInfo ? valInfo.date : "—") +
      (valInfo && valInfo.motif ? " · écart n°1 motivé : " + escapeHtml(valInfo.motif) : " · conforme à la proposition du moteur") + ".</p>" +
      "<div style='background:var(--blue-light);border-radius:12px;padding:18px;margin:14px 0;'>" +
      "<div class='price-tag' style='text-align:left;'><b style='font-size:32px;'>" + formatEuro(reco.prixComparable) + "</b>" +
      "<span>prix comparable en " + escapeHtml(DEVISE_RFQ) + "</span></div>" +
      "<div style='display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:13.5px;color:#617795;'>" +
      "<span>⏱️ Délai : <b style='color:#1b2d49;'>" + escapeHtml(reco.delai) + "</b></span>" +
      "<span>📅 Validité : <b style='color:#1b2d49;'>" + escapeHtml(reco.validite) + "</b></span>" +
      "<span>Offre <b style='color:#1b2d49;'>" + escapeHtml(reco.lettre) + "</b></span>" +
      "</div></div>" +
      "<div class='divider'></div>" +
      "<div style='display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;'>" +
      "<div class='box'><span>Prix comparable</span><b>" + formatEuro(reco.prixComparable) + "</b></div>" +
      "<div class='box'><span>Commission (barème) sur " + formatEuro(assiette) + "</span><b>" + formatEuro(commission) + "</b></div>" +
      "</div>" +
      "<h4 style='color:#0f2c4e;font-size:14.5px;margin-bottom:8px;'>Conditions importantes</h4>" +
      "<p style='font-size:13.5px;color:#617795;margin-bottom:6px;'>" + escapeHtml(reco.conditions) + "</p>" +
      "<p style='font-size:13.5px;color:#617795;'><b>Services :</b> " + escapeHtml(reco.services || "—") + "</p>" +
      secoursHtml +
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
    var assiette = reco.assietteCommission != null ? reco.assietteCommission : reco.prix;
    var commission = Commission.calculer(assiette).commission;
    var affaire = {
      ref: rfq.ref,
      ligne: rfq.origine.ville + " → " + rfq.dest.ville,
      mode: rfq.mode,
      offre: reco.lettre,
      prix: reco.prixComparable != null ? reco.prixComparable : reco.prix,
      devise: reco.deviseComparaison || reco.devise,
      assietteCommission: assiette,
      commission: commission,
      date: nowFr(),
      valideePar: (Moteur.getValidations()[rfq.ref] || {}).par || "Administrateur",
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
    toast("Affaire confirmée — identités dévoilées, commission de " + formatEuro(commission) + " enregistrée (assiette " + formatEuro(assiette) + ").", "ok");
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
