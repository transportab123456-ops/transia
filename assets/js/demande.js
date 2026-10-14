/* ============================================================
   Transia — demande.html : création d'une RFQ
   ============================================================ */
(function () {
  var DB = window.DB;

  /* ---------- Remplissage des listes ---------- */
  var modeSel = document.getElementById("mode");
  DB.modes.forEach(function (m) {
    var o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    modeSel.appendChild(o);
  });

  var incSel = document.getElementById("incoterm");
  DB.incoterms.forEach(function (i) {
    var o = document.createElement("option");
    o.value = i.code;
    o.textContent = i.libelle;
    incSel.appendChild(o);
  });

  /* ---------- Mode : bloc maritime ---------- */
  var maritimeBlock = document.getElementById("maritimeBlock");
  var acheminement = document.getElementById("acheminement");
  var conteneurField = document.getElementById("conteneurField");

  function syncMode() {
    maritimeBlock.classList.toggle("hidden", modeSel.value !== "Maritime");
  }
  modeSel.addEventListener("change", syncMode);
  syncMode();

  acheminement.addEventListener("change", function () {
    conteneurField.classList.toggle("hidden", acheminement.value === "LCL");
  });

  /* ---------- Marchandises dangereuses ---------- */
  var dangerBlock = document.getElementById("dangerBlock");
  document.querySelectorAll('input[name="dangereux"]').forEach(function (r) {
    r.addEventListener("change", function () {
      var oui = document.querySelector('input[name="dangereux"]:checked').value === "oui";
      dangerBlock.classList.toggle("hidden", !oui);
    });
  });

  /* ---------- Génération de référence ---------- */
  function nextRef() {
    var all = getAllRfqs();
    var max = 36;
    all.forEach(function (r) {
      var n = parseInt(String(r.ref).replace(/\D/g, ""), 10);
      if (!isNaN(n) && n > max) max = n;
    });
    return "RFQ-" + String(max + 1).padStart(5, "0");
  }

  /* ---------- Validation + enregistrement ---------- */
  var form = document.getElementById("formRfq");
  var formWrap = document.getElementById("formWrap");
  var successBox = document.getElementById("successBox");

  function get(id) {
    return document.getElementById(id);
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();

    var ids = ["oPays", "oVille", "oLieu", "oDate", "dPays", "dVille", "dLieu", "mDesc", "mPoids", "mVolume", "cNom", "cEmail", "cTel"];
    var ok = true;
    ids.forEach(function (id) {
      if (!required(get(id))) ok = false;
    });

    var email = get("cEmail").value.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      markInvalid(get("cEmail"), true);
      ok = false;
    }

    var dangereux = document.querySelector('input[name="dangereux"]:checked').value === "oui";
    if (dangereux) {
      ["dOnu", "dDesignation", "dClasse", "dQuantite"].forEach(function (id) {
        if (!required(get(id))) ok = false;
      });
    }

    if (!ok) {
      toast("Merci de compléter les champs obligatoires.", "err");
      var firstBad = document.querySelector(".field.invalid");
      if (firstBad) firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    var ref = nextRef();
    var rfq = {
      ref: ref,
      origine: {
        pays: get("oPays").value.trim(),
        ville: get("oVille").value.trim(),
        cp: get("oCp").value.trim() || "—",
        lieu: get("oLieu").value.trim(),
        date: get("oDate").value ? formatDateFr(get("oDate").value) : "—"
      },
      dest: {
        pays: get("dPays").value.trim(),
        ville: get("dVille").value.trim(),
        cp: get("dCp").value.trim() || "—",
        lieu: get("dLieu").value.trim()
      },
      mode: modeSel.value,
      marchandise: {
        type: modeSel.value === "Maritime" && acheminement.value === "FCL" ? "Conteneur " + get("conteneur").value : (get("mPalettes").value ? "Palettes" : "Colis"),
        desc: get("mDesc").value.trim(),
        colis: get("mColis").value || "—",
        palettes: get("mPalettes").value || "—",
        poids: get("mPoids").value.trim(),
        volume: get("mVolume").value.trim(),
        dims: get("mDims").value.trim() || "—"
      },
      incoterm: incSel.value,
      dangereuse: dangereux,
      dangerInfo: dangereux
        ? {
            onu: get("dOnu").value.trim(),
            designation: get("dDesignation").value.trim(),
            classe: get("dClasse").value.trim(),
            groupe: get("dGroupe").value.trim() || "—",
            quantite: get("dQuantite").value.trim(),
            doc: get("dDoc").value
          }
        : null,
      contact: {
        nom: get("cNom").value.trim(),
        fonction: get("cFonction").value.trim() || "Contact opérationnel",
        email: email,
        tel: get("cTel").value.trim()
      },
      statut: "OUVERTE",
      reponses: 0,
      origineSource: "user"
    };

    saveRfqUser(rfq);

    /* ---------- Écran de succès ---------- */
    document.getElementById("refCode").textContent = ref;
    document.getElementById("successDetails").innerHTML =
      "<b>" + escapeHtml(rfq.origine.ville) + " (" + escapeHtml(rfq.origine.pays) + ")</b> → <b>" +
      escapeHtml(rfq.dest.ville) + " (" + escapeHtml(rfq.dest.pays) + ")</b> · " +
      escapeHtml(rfq.mode) + " · Incoterm " + escapeHtml(rfq.incoterm) +
      (rfq.dangereuse ? " · ⚠️ ADR" : "");

    document.getElementById("linkComparateur").href = "comparateur.html?ref=" + encodeURIComponent(ref);

    /* Transporteurs susceptibles de répondre (démo) */
    var cibles = DB.transporteurs.filter(function (t) {
      return (t.statut === "ACTIF" || t.statut === "VALIDÉ") && t.modes.indexOf(rfq.mode) !== -1;
    });
    var zone = document.getElementById("matchList");
    zone.innerHTML = "";
    if (cibles.length) {
      var titre = document.createElement("p");
      titre.style.cssText = "font-weight:700;color:#0b2545;margin-bottom:10px;";
      titre.textContent = "Transporteurs notifiés (anonymes jusqu'à acceptation) :";
      zone.appendChild(titre);
    }
    cibles.slice(0, 4).forEach(function (t) {
      var row = document.createElement("div");
      row.className = "match-item";
      row.innerHTML =
        '<div class="avatar">' + initials(t.nom) + "</div>" +
        "<div><b>Transporteur " + escapeHtml(t.id) + "</b><br /><span style='font-size:12.5px;color:#5b6b84;'>" +
        escapeHtml(t.modes.join(" · ")) + " — couvre " + escapeHtml(t.lignes) + "</span></div>" +
        '<span class="badge badge-blue">' + escapeHtml(t.statut) + "</span>";
      zone.appendChild(row);
    });

    formWrap.classList.add("hidden");
    successBox.classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast("Demande " + ref + " publiée.", "ok");
  });

  /* ---------- Boutons de l'écran succès ---------- */
  document.getElementById("btnNouvelleRfq").addEventListener("click", function () {
    form.reset();
    syncMode();
    dangerBlock.classList.add("hidden");
    successBox.classList.add("hidden");
    formWrap.classList.remove("hidden");
    document.querySelectorAll(".field.invalid").forEach(function (f) { f.classList.remove("invalid"); });
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  function formatDateFr(iso) {
    var p = iso.split("-");
    return p[2] + "/" + p[1] + "/" + p[0];
  }
})();
