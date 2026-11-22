/* ============================================================
   Transia — assets/js/live.js
   Pont vers l'API réelle. Exécuté APRÈS le JS de démonstration :
   - utilisateur connecté + bon rôle → les écrans appellent l'API
   - sinon → la démo reste active (avec bannière)
   L'interception se fait en phase de capture sur document, ce qui
   empêche les handlers démo de s'exécuter sans les modifier.
   ============================================================ */
(function () {
  function get(id) { return document.getElementById(id); }
  var page = (window.location.pathname.split("/").pop() || "index.html").replace(".html", "");

  API.me().then(function (user) {
    if (page === "demande" && API.isShipper(user)) return initDemande(user);
    if (page === "transporteur" && API.isCarrier(user)) return initTransporteur(user);
    if (page === "comparateur" && API.isShipper(user)) return initComparateur(user);
    if (page === "espace-donneur" && API.isShipper(user)) return initEspace(user);
    if (page === "admin" && API.isPlatform(user)) return initAdmin(user);
    /* Pas de session adaptée : démo + bannière */
    API.demoBanner();
  });

  function h(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function euro(n) { return Number(n).toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + " €"; }
  function modeFr(code) { return API.modeLabel(code); }
  function modeIco(code) { return { ROAD: "🚚", SEA: "🚢", AIR: "✈️", MULTIMODAL: "🔗" }[code] || "📦"; }
  function badge(statut) {
    var map = { OPEN: "badge-blue", PUBLISHED: "badge-blue", RECOMMENDED: "badge-amber", ACCEPTED: "badge-amber", CONFIRMED: "badge-green", CLOSED: "badge-grey", REFUSED: "badge-grey", CANCELLED: "badge-grey", VERIFIED: "badge-green", PENDING: "badge-amber", SUSPENDED: "badge-red", REJECTED: "badge-red" };
    return "<span class='badge " + (map[statut] || "badge-grey") + "'>" + h(statut) + "</span>";
  }

  /* ============================================================
     DEMANDE (donneur d'ordre) — création réelle d'une RFQ
     ============================================================ */
  function initDemande(user) {
    document.addEventListener("submit", function (e) {
      if (e.target.id !== "formRfq") return;
      e.preventDefault();
      e.stopPropagation();
      submitRfq();
    }, true);

    function val(id) { var el = get(id); return el ? el.value.trim() : ""; }
    function requiredLive(id) {
      var el = get(id);
      var ok = el && String(el.value).trim() !== "";
      if (el) el.closest(".field").classList.toggle("invalid", !ok);
      return ok;
    }

    function submitRfq() {
      var ok = true;
      ["oPays", "oVille", "oLieu", "dPays", "dVille", "dLieu", "mDesc"].forEach(function (id) {
        if (!requiredLive(id)) ok = false;
      });
      if (!ok) { toast("Merci de compléter les champs obligatoires.", "err"); return; }

      var oIso = API.countryCode(val("oPays"));
      var dIso = API.countryCode(val("dPays"));
      if (!oIso || !dIso) { toast("Pays inconnu : sélectionnez une suggestion de la liste.", "err"); return; }

      var dangereux = document.querySelector('input[name="dangereux"]:checked') &&
                      document.querySelector('input[name="dangereux"]:checked').value === "oui";

      var payload = {
        originCity: val("oVille"), originCountry: oIso,
        originPostalCode: val("oCp") || null,
        originPublicLocation: val("oLieu") || val("oVille"),
        destinationCity: val("dVille"), destinationCountry: dIso,
        destinationPostalCode: val("dCp") || null,
        destinationPublicLocation: val("dLieu") || val("dVille"),
        mode: API.modeCode(get("mode").value),
        incoterm: get("incoterm").value || null,
        pickupDate: val("oDate") || null,
        cargoDescription: val("mDesc"),
        packageCount: API.num(val("mColis")),
        palletCount: API.num(val("mPalettes")),
        grossWeight: API.num(val("mPoids")),
        volume: API.num(val("mVolume")),
        dangerousGoods: dangereux,
        unNumber: dangereux ? val("dOnu") : null,
        hazardClass: dangereux ? val("dClasse") : null
      };

      var btn = document.querySelector("#formRfq button[type=submit]");
      if (btn) { btn.disabled = true; btn.textContent = "Publication…"; }

      API.post("/api/rfqs", payload).then(function (r) {
        if (btn) { btn.disabled = false; btn.textContent = btn.textContent.replace("Publication…", "Publier ma demande"); }
        if (r.status === 401) { toast("Connectez-vous pour publier une demande.", "err"); setTimeout(function () { window.location.href = "auth.html"; }, 900); return; }
        if (!r.ok) { toast(r.body.error || "Publication impossible.", "err"); return; }

        var ref = r.body.rfq.rfq_number;
        get("refCode").textContent = ref;
        get("successDetails").innerHTML =
          "<b>" + h(payload.originCity) + " (" + h(payload.originCountry) + ")</b> → <b>" +
          h(payload.destinationCity) + " (" + h(payload.destinationCountry) + ")</b> · " +
          h(modeFr(payload.mode)) + (payload.incoterm ? " · Incoterm " + h(payload.incoterm) : "") +
          (dangereux ? " · ⚠️ ADR" : "");
        get("linkComparateur").href = "comparateur.html?ref=" + encodeURIComponent(ref);
        var match = get("matchList");
        if (match) match.innerHTML = "<p style='font-size:13.5px;color:#617795;'>Votre demande est publiée sur le marché : les transporteurs vérifiés la voient <b>à l'aveugle</b> (sans votre identité) et déposent leurs offres.</p>";
        get("formWrap").classList.add("hidden");
        get("successBox").classList.remove("hidden");
        window.scrollTo({ top: 0, behavior: "smooth" });
        toast("Demande " + ref + " publiée.", "ok");
      }).catch(function () { toast("Service injoignable.", "err"); if (btn) btn.disabled = false; });
    }
  }

  /* ============================================================
     TRANSPORTEUR — marché réel + dépôt d'offre réel
     ============================================================ */
  function initTransporteur(user) {
    var rfqsCache = [];

    /* Panneau compte : état réel de vérification */
    API.get("/api/carriers").then(function (r) {
      if (!r.ok) return;
      var v = r.body.verification || {};
      var panel = get("comptePanel");
      var statutBadge = v.status === "VERIFIED" ? "<span class='badge badge-green'>Vérifié</span>"
        : v.status === "SUSPENDED" ? "<span class='badge badge-red'>Suspendu</span>"
        : v.status === "REJECTED" ? "<span class='badge badge-red'>Rejeté</span>"
        : "<span class='badge badge-amber'>À vérifier</span>";
      panel.innerHTML =
        "<div style='display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap;'>" +
        "<div style='display:flex;gap:14px;align-items:center;'>" +
        "<div class='avatar' style='width:52px;height:52px;font-size:18px;'>" + h((r.body.company.legal_name || "?").slice(0, 2).toUpperCase()) + "</div>" +
        "<div><h3 class='mb-0'>" + h(r.body.company.legal_name) + " " + statutBadge + "</h3>" +
        "<p class='muted' style='font-size:13.5px;margin:0;'>Modes : " + h((r.body.modes || []).map(modeFr).join(" · ") || "—") +
        (r.body.company.status ? " · société : " + h(r.body.company.status) : "") + "</p></div></div></div>" +
        (v.status !== "VERIFIED"
          ? "<div class='info-banner' style='margin-top:16px;'>🛡️ <span>Votre compte est <b>" + h(v.status === "PENDING" ? "à vérifier" : v.status.toLowerCase()) + "</b> : la plateforme contrôle vos justificatifs et garde la décision finale. Vous ne pouvez pas encore déposer d'offres.</span></div>"
          : "<div class='info-banner' style='margin-top:16px;'>✅ <span>Compte vérifié — vous pouvez consulter le marché et déposer des offres à l'aveugle.</span></div>");
    });

    /* Marché réel (remplace la table démo) */
    function loadMarche() {
      var qs = [];
      if (get("fMode").value) qs.push("mode=" + API.modeCode(get("fMode").value));
      API.get("/api/marketplace" + (qs.length ? "?" + qs.join("&") : "")).then(function (r) {
        if (!r.ok) {
          if (r.status === 403) {
            get("rfqBody").innerHTML = "<tr><td colspan='8' class='muted' style='padding:20px;'>Accès au marché réservé aux transporteurs vérifiés.</td></tr>";
          }
          return;
        }
        rfqsCache = r.body.rfqs || [];
        var oP = get("fDepart").value, oA = get("fArrivee").value, oT = get("fType").value;
        var list = rfqsCache.filter(function (x) {
          return (!oP || x.origin_country === oP) && (!oA || x.destination_country === oA) &&
                 (!oT || String(x.gross_weight || "") === oT);
        });
        render(list);
      });
    }

    function render(list) {
      var body = get("rfqBody");
      body.innerHTML = "";
      get("countRfq").textContent = list.length;
      get("emptyState").classList.toggle("hidden", list.length > 0);
      get("rfqTable").classList.toggle("hidden", list.length === 0);
      list.forEach(function (x) {
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td><b>" + h(x.rfq_number) + "</b></td>" +
          "<td>" + h(x.origin_city) + "<br /><span class='muted' style='font-size:12px;'>" + h(API.countryName(x.origin_country)) + "</span></td>" +
          "<td>" + h(x.destination_city) + "<br /><span class='muted' style='font-size:12px;'>" + h(API.countryName(x.destination_country)) + "</span></td>" +
          "<td><span class='mode-badge'>" + modeIco(x.mode) + " " + h(modeFr(x.mode)) + "</span></td>" +
          "<td>" + (x.gross_weight ? h(String(x.gross_weight)) + " kg" : "—") + (x.dangerous_goods ? " ⚠️" : "") + "</td>" +
          "<td>" + h(x.pickup_date || "—") + "</td>" +
          "<td>" + badge(x.status) + "</td>" +
          "<td>" + (x.already_quoted
            ? "<span class='badge badge-green'>Offre déposée</span>"
            : "<button class='btn btn-primary btn-sm' data-quoted='" + h(x.rfq_number) + "'>Répondre</button>") + "</td>";
        body.appendChild(tr);
      });
      body.querySelectorAll("button[data-quoted]").forEach(function (b) {
        b.addEventListener("click", function () { ouvrirReponse(b.getAttribute("data-quoted")); });
      });
    }

    /* Remplir les filtres avec les pays réels du marché */
    function fillFilters() {
      var seen = {};
      rfqsCache.forEach(function (x) { seen[x.origin_country] = 1; seen[x.destination_country] = 1; });
      [["fDepart", "origin_country"], ["fArrivee", "destination_country"]].forEach(function (pair) {
        var sel = get(pair[0]);
        var current = sel.value;
        sel.innerHTML = "<option value=''>Tous</option>";
        Object.keys(seen).forEach(function (iso) {
          var o = document.createElement("option");
          o.value = iso; o.textContent = API.countryName(iso);
          sel.appendChild(o);
        });
        sel.value = current;
      });
    }

    /* Remplacement des handlers démo sur les filtres : rechargement réel */
    ["fDepart", "fArrivee", "fMode"].forEach(function (id) {
      var el = get(id);
      el.replaceWith(el.cloneNode(true)); /* retire les listeners démo */
      get(id).addEventListener("change", loadMarche);
    });
    var reset = get("btnReset");
    reset.replaceWith(reset.cloneNode(true));
    get("btnReset").addEventListener("click", function () {
      get("fDepart").value = ""; get("fArrivee").value = ""; get("fMode").value = "";
      loadMarche();
    });

    /* ---------- Modale de réponse : dépôt réel ---------- */
    var refCourante = null;
    function ouvrirReponse(ref) {
      refCourante = ref;
      var detail = rfqsCache.filter(function (x) { return x.rfq_number === ref; })[0];
      get("reponseRef").textContent = ref + " — " + modeFr(detail ? detail.mode : "");
      get("reponseInfo").innerHTML = detail
        ? "<b>" + h(detail.origin_city) + " (" + h(API.countryName(detail.origin_country)) + ") → " +
          h(detail.destination_city) + " (" + h(API.countryName(detail.destination_country)) + ")</b><br />" +
          (detail.description ? h(detail.description) + " · " : "") +
          (detail.gross_weight ? h(String(detail.gross_weight)) + " kg · " : "") +
          (detail.volume ? h(String(detail.volume)) + " m³" : "") + "<br />" +
          "Incoterm " + h(detail.incoterm || "—") + " · enlèvement " + h(detail.pickup_date || "—") +
          (detail.dangerous_goods ? "<br /><b style='color:#96650f;'>⚠️ Marchandise dangereuse</b>" : "")
        : "";
      openModal("modalReponse");
    }

    var sendBtn = get("btnEnvoyerOffre");
    sendBtn.replaceWith(sendBtn.cloneNode(true));
    get("btnEnvoyerOffre").addEventListener("click", function () {
      if (!refCourante) return;
      var prix = parseFloat(String(get("rPrix").value).replace(",", "."));
      if (!isFinite(prix) || prix <= 0) { toast("Prix obligatoire.", "err"); return; }
      var frais = String(get("rFrais").value || "").trim();
      var fraisNum = API.num(frais);

      /* Lecture du délai : "5 jours" → 5 / day ; "48 h" → 48 / hour */
      var delaiText = String(get("rDelai").value || "").trim();
      var m = delaiText.match(/(\d+)\s*(h|hour|jour|jours|day|days|sem|week)/i);
      var payload = {
        rfqNumber: refCourante,
        currency: get("rDevise").value || "EUR",
        baseTransportPrice: prix,
        feesToSpecify: frais === "" ? true : false,
        mandatoryFeesTotal: fraisNum === null ? 0 : fraisNum,
        transitTimeValue: m ? parseInt(m[1], 10) : null,
        transitTimeUnit: m && /h|hour/i.test(m[2]) ? "hour" : "day",
        validUntil: get("rValidite").value || null,
        conditions: get("rConditions").value.trim() || null,
        scopeComparable: !document.getElementById("rScopeDiff") || !get("rScopeDiff").checked
      };

      API.post("/api/quotes", payload).then(function (r) {
        if (r.status === 401) { toast("Session expirée — reconnectez-vous.", "err"); return; }
        if (r.status === 403) { toast(r.body.error || "Compte non vérifié.", "err"); return; }
        if (!r.ok) { toast(r.body.error || "Dépôt impossible.", "err"); return; }
        closeModal("modalReponse");
        ["rPrix", "rDelai", "rValidite", "rConditions", "rFrais"].forEach(function (id) { get(id).value = ""; });
        toast("Offre déposée pour " + refCourante + " — à l'aveugle, comme toutes les autres.", "ok");
        loadMarche();
        loadMesOffres();
      }).catch(function () { toast("Service injoignable.", "err"); });
    });

    /* ---------- Mes offres (réelles) ---------- */
    function loadMesOffres() {
      var zone = get("mesOffres");
      var mesRefs = rfqsCache.filter(function (x) { return x.already_quoted; });
      if (!mesRefs.length) {
        zone.innerHTML = "<p class='muted' style='font-size:13.5px;'>Aucune offre déposée pour l'instant. Cliquez sur « Répondre » à côté d'une demande.</p>";
        return;
      }
      var remaining = mesRefs.length;
      zone.innerHTML = "";
      mesRefs.forEach(function (x) {
        API.get("/api/quotes?rfq=" + encodeURIComponent(x.rfq_number)).then(function (r) {
          if (r.ok) {
            var q = (r.body.quotes || [])[0];
            var div = document.createElement("div");
            div.style.cssText = "border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px;";
            div.innerHTML =
              "<div style='display:flex;justify-content:space-between;align-items:center;gap:8px;'>" +
              "<b style='color:#0f2c4e;'>" + h(x.rfq_number) + "</b>" +
              "<span class='badge badge-blue'>v" + h(q ? q.version : "?") + " · " + h(q ? q.statutTechnique : "") + "</span></div>" +
              "<div style='font-size:13px;color:#617795;margin-top:4px;'>" +
              h(x.origin_city) + " → " + h(x.destination_city) + " · <b style='color:#1b2d49;'>" +
              euro(q ? q.base_transport_price : 0) + " " + h(q ? q.currency : "") + "</b>" +
              (q && q.prixComparable != null ? " · comparable <b>" + euro(q.prixComparable) + "</b>" : " · frais à préciser") + "</div>";
            zone.appendChild(div);
          }
          if (--remaining === 0 && !zone.children.length) {
            zone.innerHTML = "<p class='muted' style='font-size:13.5px;'>Aucune offre déposée pour l'instant.</p>";
          }
        });
      });
    }

    /* Décor : le sélecteur de devise doit être rechargé (démo le fait déjà) */
    loadMarcheOriginalPatches();
    function loadMarcheOriginalPatches() {
      /* la table démo est déjà rendue par transporteur.js : on la remplace */
      API.get("/api/marketplace").then(function (r) {
        if (r.ok) { rfqsCache = r.body.rfqs || []; fillFilters(); loadMarche(); }
        loadMesOffres();
      });
    }
  }

  /* ============================================================
     COMPARATEUR — offres réelles + recommandation + acceptation
     ============================================================ */
  function initComparateur(user) {
    var select = get("selectRfq");
    /* Vider et recharger la liste avec les RFQ réelles du donneur */
    API.get("/api/rfqs").then(function (r) {
      if (!r.ok) return;
      select.innerHTML = "";
      (r.body.rfqs || []).forEach(function (x) {
        var o = document.createElement("option");
        o.value = x.rfq_number;
        o.textContent = x.rfq_number + " — " + x.origin_city + " → " + x.destination_city + " (" + modeFr(x.mode) + ")";
        select.appendChild(o);
      });
      var params = new URLSearchParams(window.location.search);
      var pre = params.get("ref");
      if (pre && Array.prototype.some.call(select.options, function (o) { return o.value === pre; })) select.value = pre;
      var fresh = select.cloneNode(true);
      select.replaceWith(fresh);
      get("selectRfq").addEventListener("change", rendre);
      rendre();
    });

    function rendre() {
      var ref = get("selectRfq").value;
      if (!ref) { get("recoBox").innerHTML = "<p class='muted'>Aucune demande — déposez d'abord une RFQ.</p>"; return; }

      Promise.all([
        API.get("/api/quotes?rfq=" + encodeURIComponent(ref)),
        API.get("/api/recommendations?rfq=" + encodeURIComponent(ref))
      ]).then(function (res) {
        var quotes = res[0].ok ? res[0].body : { quotes: [] };
        var rec = res[1].ok ? res[1].body : { status: "NONE" };
        var deal = quotes.deal || null;
        var rfqStatus = quotes.rfqStatus;

        /* Résumé */
        var list = quotes.quotes || [];
        var first = list[0];
        get("rfqResume").innerHTML =
          "<b style='color:#0f2c4e;'>" + h(ref) + "</b> · " +
          (first ? "" : "") + badge(rfqStatus || "OPEN") +
          (deal ? " · affaire <b>" + h(deal.deal_number) + "</b>" : "") +
          "<br /><span style='font-size:13px;color:#617795;'>Offres reçues : " + list.length +
          " — cotations à l'aveugle, identités masquées" + (deal ? " jusqu'à confirmation" : "") + ".</span>";

        /* Tableau des offres */
        get("offersEmpty").classList.toggle("hidden", list.length > 0);
        get("offersWrap").classList.toggle("hidden", list.length === 0);
        var body = get("offresBody");
        body.innerHTML = "";
        get("countOffres").textContent = list.length;

        var ranked = list.filter(function (q) { return q.rank != null; });
        var reco = rec.recommended || null;

        list.forEach(function (q) {
          var estReco = reco && q.quote_id === reco.quote_id;
          var tr = document.createElement("tr");
          if (estReco && !deal) tr.style.background = "var(--blue-light)";
          var statutBadge = q.statutTechnique === "NON_CONFORME" ? "<span class='badge badge-red'>Non conforme</span>"
            : q.statutTechnique === "A_VERIFIER" ? "<span class='badge badge-amber'>À vérifier</span>"
            : "<span class='badge badge-green'>Conforme</span>";
          tr.innerHTML =
            "<td><b>Offre " + h(q.letter) + "</b>" + (estReco && !deal ? " <span class='badge badge-blue'>Recommandée</span>" : "") +
            (q.rank ? " · n°" + q.rank : "") +
            "<br /><span style='font-size:11.5px;color:#9fb2cc;'>" + h(q.currency) + " origine · v" + h(q.version) + "</span></td>" +
            "<td>" + (q.prixComparable == null
              ? "<span style='color:#96650f;'>à déterminer</span>"
              : "<b>" + euro(q.prixComparable) + "</b>") +
            "<br /><span style='font-size:11.5px;color:#9fb2cc;'>" +
            (q.transportConv != null ? "transport " + euro(q.transportConv) : "") +
            (q.feesConv ? " + frais " + euro(q.feesConv) : "") + "</span></td>" +
            "<td>" + (q.transitTime ? h(q.transitTime.value) + " " + h(q.transitTime.unit === "hour" ? "h" : q.transitTime.unit === "week" ? "sem." : "j") : "—") + "</td>" +
            "<td>" + h(q.validUntil || "—") + "</td>" +
            "<td style='font-size:13px;'>" + h(q.conditions || "—") + "</td>" +
            "<td>" + statutBadge + "</td>";
          body.appendChild(tr);
        });

        /* Notes conformité */
        var note = get("nonConformNote");
        var msgs = [];
        var ecartees = list.filter(function (q) { return q.statutTechnique === "NON_CONFORME"; });
        var clarifier = list.filter(function (q) { return q.statutTechnique === "A_VERIFIER"; });
        if (ecartees.length) msgs.push("⚖️ <span><b>Offres écartées :</b> " + ecartees.map(function (q) { return "Offre " + h(q.letter) + " — " + h(q.motifNonConformite || "périmètre différent"); }).join(" · ") + "</span>");
        if (clarifier.length) msgs.push("🔎 <span><b>À clarifier :</b> " + clarifier.map(function (q) { return "Offre " + h(q.letter) + " — frais obligatoires à préciser"; }).join(" · ") + "</span>");
        if (msgs.length) { note.classList.remove("hidden"); note.innerHTML = msgs.join("<br />"); }
        else note.classList.add("hidden");

        rendreReco(rec, quotes, deal, list);
      });
    }

    function rendreReco(rec, quotes, deal, list) {
      var box = get("recoBox");

      /* Affaire confirmée : dévoilement */
      if (deal) {
        var carrier = (list.filter(function (q) { return q.carrier; })[0] || {}).carrier;
        box.innerHTML =
          "<h3 class='mt-0'>✅ Affaire confirmée</h3>" +
          "<p style='font-size:13.5px;color:#617795;'>Horodatée le " + h(new Date(deal.confirmed_at).toLocaleString("fr-FR")) + " · réf. <b>" + h(deal.deal_number) + "</b></p>" +
          "<div class='divider'></div>" +
          "<div class='track-summary' style='grid-template-columns:1fr 1;'>" +
          "<div class='box'><span>Prix accepté</span><b>" + euro(deal.transport_amount) + " " + h(deal.currency || "EUR") + "</b></div>" +
          "<div class='box'><span>Commission — taux effectif " + (parseFloat(deal.commission_rate) * 100).toFixed(2).replace(".", ",") + " %</span><b>" + euro(deal.commission_amount) + "</b></div>" +
          "</div>" +
          "<p style='font-size:12.5px;color:#617795;'>Assiette : la partie transport de l'opération. Facturée au transporteur.</p>" +
          "<div class='divider'></div>" +
          "<h4 style='color:#0f2c4e;margin-bottom:12px;'>🔓 Identités dévoilées</h4>" +
          (carrier
            ? "<div style='border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:10px;'><b style='color:#0f2c4e;'>" + h(carrier.legal_name) + "</b> <span class='badge badge-green'>Transporteur</span>" +
              "<p style='font-size:13px;color:#617795;margin-top:6px;'>" + h(carrier.main_phone || "") + " · " + h(carrier.main_email || "") + "</p></div>"
            : "") +
          "<div style='border:1px solid var(--line);border-radius:10px;padding:14px;'><b style='color:#0f2c4e;'>" + h(user.first_name + " " + user.last_name) + "</b> <span class='badge badge-blue'>Donneur d'ordre</span>" +
          "<p style='font-size:13px;color:#617795;margin-top:6px;'>" + h(user.email) + "</p></div>" +
          "<p style='font-size:12.5px;color:#617795;margin-top:12px;'>Contrat de transport conclu directement entre les parties, sous clause de non-contournement.</p>";
        return;
      }

      if (rec.status === "PENDING_ADMIN") {
        box.innerHTML =
          "<h3 class='mt-0'>⏳ Analyse en cours</h3>" +
          "<p style='font-size:14px;color:#617795;'>" + h(rec.message || "La plateforme classe les offres : l'administration valide la recommandation avant qu'elle ne vous soit présentée.") + "</p>";
        return;
      }

      if (rec.status === "NO_CONFORME_QUOTE") {
        box.innerHTML =
          "<h3 class='mt-0'>🔎 Aucune offre conforme</h3>" +
          "<p style='font-size:14px;color:#617795;'>" + h(rec.message || "Clarification requise avant recommandation.") + "</p>";
        return;
      }

      if (!rec.recommended) {
        box.innerHTML =
          "<h3 class='mt-0'>⏳ En attente d'offres</h3>" +
          "<p style='font-size:14px;color:#617795;'>Dès qu'au moins une offre conforme sera reçue et validée, la plateforme vous recommandera la meilleure.</p>" +
          "<div class='divider'></div>" +
          "<p style='font-size:13px;color:#617795;'>Rappel : les transporteurs cotent à l'aveugle — le nombre d'offres n'est jamais communiqué aux transporteurs.</p>";
        return;
      }

      /* Recommandation validée */
      var reco = rec.recommended;
      var assiette = parseFloat(reco.commissionable_amount);
      var lettre = reco.letter;
      box.innerHTML =
        "<h3 class='mt-0'>🏆 Offre recommandée</h3>" +
        "<p style='font-size:13px;color:#617795;'>Validée par l'administration" + (reco.validatedAt ? " le " + h(new Date(reco.validatedAt).toLocaleDateString("fr-FR")) : "") + ".</p>" +
        "<div style='background:var(--blue-light);border-radius:12px;padding:18px;margin:14px 0;'>" +
        "<div class='price-tag' style='text-align:left;'><b style='font-size:32px;'>" + euro(reco.comparable_total) + "</b>" +
        "<span>prix comparable (transport + frais obligatoires) en EUR</span></div>" +
        "<div style='display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:13.5px;color:#617795;'><span>Offre <b style='color:#1b2d49;'>" + h(lettre || "?") + "</b></span></div></div>" +
        "<div class='info-banner' style='margin:14px 0;'>🧮 <span><b>Normalisation appliquée :</b> prix comparable = transport + frais obligatoires (options exclues), converti en EUR. L'assiette de commission reste la seule partie transport (" + euro(assiette) + ").</span></div>" +
        "<button class='btn btn-primary btn-block btn-lg' id='btnAccepterLive'>Accepter l'offre</button>" +
        "<button class='btn btn-outline btn-block' id='btnRefuserLive' style='margin-top:10px;'>Refuser l'offre</button>";

      get("btnAccepterLive").addEventListener("click", function () {
        var ref = get("selectRfq").value;
        if (!confirm("Accepter l'offre " + (lettre || "") + " (" + euro(reco.comparable_total) + ") ? Le transporteur devra confirmer pour créer l'affaire.")) return;
        API.post("/api/deals", { action: "accept", rfqNumber: ref }).then(function (r) {
          if (!r.ok) { toast(r.body.error || "Acceptation impossible.", "err"); return; }
          toast("Offre acceptée — en attente de la confirmation du transporteur.", "ok");
          rendre();
        });
      });

      get("btnRefuserLive").addEventListener("click", function () {
        var ref = get("selectRfq").value;
        var motif = window.prompt("Motif du refus (obligatoire, utilisé pour l'analyse commerciale) :\n- Prix trop élevé\n- Délai\n- Besoin annulé\n- Transport déjà attribué\n- Modification du besoin\n- Autre");
        if (motif === null) return;
        if (!motif.trim()) { toast("Motif obligatoire.", "err"); return; }
        API.post("/api/deals", { action: "refuse", rfqNumber: ref, motif: motif.trim(), closeRfq: false }).then(function (r) {
          if (!r.ok) { toast(r.body.error || "Refus impossible.", "err"); return; }
          toast("Refus enregistré — merci, ce motif alimente l'analyse commerciale.", "ok");
          rendre();
        });
      });
    }

    rendre();
  }

  /* ============================================================
     ESPACE DONNEUR — tableau de bord réel
     ============================================================ */
  function initEspace(user) {
    Promise.all([
      API.get("/api/rfqs"),
      API.get("/api/deals")
    ]).then(function (res) {
      var rfqs = res[0].ok ? res[0].body.rfqs : [];
      var dealsRes = res[1].ok ? res[1].body : { deals: [], count: 0, stats: { commission: 0 } };
      var deals = dealsRes.deals || [];
      var dealByRfq = {};
      deals.forEach(function (d) { dealByRfq[d.rfq_number] = d; });

      /* KPI */
      var kpis = [
        { icone: "📋", valeur: rfqs.length, label: "Mes demandes" },
        { icone: "✅", valeur: rfqs.filter(function (r) { return r.status === "CONFIRMED"; }).length, label: "Transports confirmés" },
        { icone: "⏳", valeur: rfqs.filter(function (r) { return r.status === "RECOMMENDED"; }).length, label: "Offres à valider" },
        { icone: "💶", valeur: euro(parseFloat(dealsRes.stats.commission) || 0), label: "Commissions (barème)" }
      ];
      get("donneurKpis").innerHTML = kpis.map(function (k) {
        return "<div class='card' style='text-align:center;'>" +
          "<div class='icon-tile' style='margin:0 auto 12px;'>" + k.icone + "</div>" +
          "<b style='display:block;font-size:26px;color:#0f2c4e;letter-spacing:-1px;'>" + k.valeur + "</b>" +
          "<span style='font-size:13px;color:#617795;'>" + k.label + "</span></div>";
      }).join("");

      /* Table des demandes */
      var body = get("mesDemandesBody");
      body.innerHTML = "";
      get("donneurEmpty").classList.toggle("hidden", rfqs.length > 0);
      body.closest(".table-wrap").classList.toggle("hidden", rfqs.length === 0);
      rfqs.forEach(function (x) {
        var st = x.status;
        var action = st === "CONFIRMED"
          ? "<a class='btn btn-outline btn-sm' href='comparateur.html?ref=" + encodeURIComponent(x.rfq_number) + "'>Voir</a>"
          : st === "RECOMMENDED"
          ? "<a class='btn btn-primary btn-sm' href='comparateur.html?ref=" + encodeURIComponent(x.rfq_number) + "'>Valider l'offre</a>"
          : "<a class='btn btn-outline btn-sm' href='comparateur.html?ref=" + encodeURIComponent(x.rfq_number) + "'>Suivre</a>";
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td><b>" + h(x.rfq_number) + "</b></td>" +
          "<td>" + h(x.origin_city) + " → " + h(x.destination_city) +
          "<br /><span class='muted' style='font-size:12px;'>" + h(API.countryName(x.origin_country) + " → " + API.countryName(x.destination_country)) + "</span></td>" +
          "<td><span class='mode-badge'>" + modeIco(x.mode) + " " + h(modeFr(x.mode)) + "</span></td>" +
          "<td style='font-size:13px;'>" + h(x.pickup_date || "—") + "</td>" +
          "<td>" + (dealByRfq[x.rfq_number] ? "<span class='badge badge-green'>affaire</span>" : "—") + "</td>" +
          "<td>" + badge(st) + "</td>" +
          "<td>" + action + "</td>";
        body.appendChild(tr);
      });

      /* Offres à valider */
      var zone = get("offresValider");
      var aValider = rfqs.filter(function (r) { return r.status === "RECOMMENDED"; });
      zone.innerHTML = aValider.length
        ? aValider.map(function (r) {
            return "<div style='border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:10px;'>" +
              "<div style='display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;'>" +
              "<b style='color:#0f2c4e;'>" + h(r.rfq_number) + "</b><span class='badge badge-green'>Prête à valider</span></div>" +
              "<div style='font-size:13px;color:#617795;margin-top:6px;'>" + h(r.origin_city + " → " + r.destination_city) + "</div>" +
              "<a class='btn btn-primary btn-sm' style='margin-top:10px;' href='comparateur.html?ref=" + encodeURIComponent(r.rfq_number) + "'>Accepter ou refuser</a></div>";
          }).join("")
        : "<p class='muted' style='font-size:13.5px;'>Aucune recommandation en attente. Vous serez notifié dès qu'une offre est prête.</p>";

      /* Affaires confirmées */
      var zoneA = get("affairesConfirmees");
      zoneA.innerHTML = deals.length
        ? deals.map(function (d) {
            return "<div style='border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:10px;'>" +
              "<div style='display:flex;justify-content:space-between;gap:10px;align-items:center;'>" +
              "<b style='color:#0f2c4e;'>" + h(d.deal_number) + "</b><span class='badge badge-green'>Confirmée</span></div>" +
              "<div style='font-size:13px;color:#617795;margin-top:6px;'>" + h(d.origin_city + " → " + d.destination_city) + "</div>" +
              "<div style='font-size:13.5px;margin-top:6px;'><b style='color:#1b2d49;'>" + euro(d.transport_amount) + " " + h(d.currency) + "</b>" +
              " · <span style='color:#617795;'>transporteur dévoilé : " + h(d.carrier_name) + "</span></div>" +
              "<div style='font-size:12px;color:#9fb2cc;margin-top:4px;'>" + h(new Date(d.confirmed_at).toLocaleString("fr-FR")) + "</div></div>";
          }).join("")
        : "<p class='muted' style='font-size:13.5px;'>Aucun transport confirmé. Acceptez une recommandation pour lancer l'opération.</p>";

      /* Historique : statuts non terminaux */
      var zoneH = get("historiqueList");
      var terminaux = rfqs.filter(function (r) { return ["CONFIRMED", "REFUSED", "CANCELLED", "CLOSED"].indexOf(r.status) >= 0; });
      zoneH.innerHTML = terminaux.length
        ? terminaux.map(function (r) {
            return "<div style='display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:11px 0;border-bottom:1px solid var(--line);'>" +
              "<div><b style='color:#0f2c4e;'>" + h(r.rfq_number) + "</b> " + badge(r.status) +
              "<br /><span style='font-size:13px;color:#617795;'>" + h(r.origin_city + " → " + r.destination_city) + "</span></div>" +
              "<span style='font-size:12.5px;color:#9fb2cc;white-space:nowrap;'>" + h(r.created_at ? new Date(r.created_at).toLocaleDateString("fr-FR") : "") + "</span></div>";
          }).join("")
        : "<p class='muted' style='font-size:13.5px;'>L'historique se remplira au fil de vos opérations (demandes, acceptations, refus).</p>";
    });
  }

  /* ============================================================
     ADMIN — back-office réel
     ============================================================ */
  function initAdmin(user) {
    /* KPI réels */
    API.get("/api/admin?view=overview").then(function (r) {
      if (!r.ok) return;
      var b = r.body;
      var kpis = [
        { icone: "📋", valeur: b.rfqs.total, label: "RFQ enregistrées", note: b.rfqs.ouvertes + " ouvertes · " + b.rfqs.confirmees + " confirmées" },
        { icone: "📝", valeur: b.quotes.total, label: "Offres déposées", note: b.metrics.taux_reponse + " % de taux de réponse" },
        { icone: "🚛", valeur: b.carriers.total, label: "Transporteurs", note: b.carriers.en_attente + " à vérifier" },
        { icone: "💶", valeur: euro(parseFloat(b.commissions.total) || 0), label: "Commissions calculées", note: b.deals.total + " affaire(s)" }
      ];
      get("kpiGrid").innerHTML = kpis.map(function (k) {
        return "<div class='card' style='text-align:center;'>" +
          "<div class='icon-tile' style='margin:0 auto 12px;'>" + k.icone + "</div>" +
          "<b style='display:block;font-size:26px;color:#0f2c4e;letter-spacing:-1px;'>" + k.valeur + "</b>" +
          "<span style='font-size:13px;color:#617795;'>" + k.label + "</span>" +
          "<br /><span style='font-size:12px;color:#9fb2cc;'>" + h(k.note) + "</span></div>";
      }).join("");

      /* File de travail */
      var todo = [
        { icone: "🛡️", n: b.carriers.en_attente, label: "transporteurs à vérifier", urgent: b.carriers.en_attente > 0 },
        { icone: "📋", n: b.rfqs.ouvertes, label: "RFQ ouvertes", urgent: false },
        { icone: "💶", n: b.commissions.en_attente, label: "commissions à facturer", urgent: false }
      ];
      get("todoGrid").innerHTML = todo.map(function (i) {
        return "<div class='card' style='padding:16px;" + (i.urgent ? "border-color:var(--amber);" : "") + "'>" +
          "<div style='display:flex;align-items:center;gap:10px;'><span style='font-size:22px;'>" + i.icone + "</span>" +
          "<div><b style='display:block;font-size:22px;color:#0f2c4e;line-height:1.1;'>" + i.n + "</b>" +
          "<span style='font-size:12.5px;color:#617795;'>" + i.label + "</span></div></div></div>";
      }).join("");
    });

    /* Vérification transporteurs (réelle) */
    API.get("/api/admin?view=carriers").then(function (r) {
      if (!r.ok) return;
      var zone = get("verifList");
      zone.innerHTML = "";
      (r.body.carriers || []).forEach(function (c) {
        var div = document.createElement("div");
        div.style.cssText = "border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:12px;";
        var st = c.validation_status || "PENDING";
        var actions = st === "VERIFIED"
          ? "<button class='btn btn-outline btn-sm' data-suspend='" + h(c.company_id) + "'>Suspendre</button>"
          : "<button class='btn btn-primary btn-sm' data-verify='" + h(c.company_id) + "'>Valider et activer</button>" +
            "<button class='btn btn-outline btn-sm' data-reject='" + h(c.company_id) + "'>Rejeter</button>";
        div.innerHTML =
          "<div style='display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:center;'>" +
          "<div style='display:flex;gap:12px;align-items:center;'>" +
          "<div class='avatar'>" + h((c.legal_name || "?").slice(0, 2).toUpperCase()) + "</div>" +
          "<div><b style='color:#0f2c4e;'>" + h(c.legal_name) + "</b> " + badge(st) +
          "<br /><span style='font-size:12.5px;color:#617795;'>" + h((c.country || "") + " · " + (c.modes || []).map(modeFr).join(" · ")) +
          (c.tax_id ? " · Immat. " + h(c.tax_id) : "") + (c.vat_number ? " · TVA " + h(c.vat_number) : "") + "</span></div></div>" +
          "<div style='display:flex;gap:8px;flex-wrap:wrap;'>" + actions + "</div></div>";
        zone.appendChild(div);
      });

      zone.querySelectorAll("[data-verify]").forEach(function (b) {
        b.addEventListener("click", function () {
          API.post("/api/admin", { action: "verify", companyId: b.getAttribute("data-verify"), decision: "VERIFIED" }).then(function (r) {
            if (!r.ok) { toast(r.body.error || "Décision impossible.", "err"); return; }
            toast("Transporteur vérifié — accès au marché activé.", "ok");
            window.location.reload();
          });
        });
      });
      zone.querySelectorAll("[data-suspend]").forEach(function (b) {
        b.addEventListener("click", function () {
          var motif = window.prompt("Motif de la suspension (obligatoire, journalisé) :");
          if (motif === null) return;
          if (!motif.trim() || motif.trim().length < 5) { toast("Motif obligatoire (5 caractères min).", "err"); return; }
          API.post("/api/admin", { action: "verify", companyId: b.getAttribute("data-suspend"), decision: "SUSPENDED", reason: motif.trim() }).then(function (r) {
            if (!r.ok) { toast(r.body.error || "Décision impossible.", "err"); return; }
            toast("Compte suspendu — motif journalisé.", "ok");
            window.location.reload();
          });
        });
      });
      zone.querySelectorAll("[data-reject]").forEach(function (b) {
        b.addEventListener("click", function () {
          var motif = window.prompt("Motif du rejet (obligatoire, journalisé) :");
          if (motif === null) return;
          if (!motif.trim() || motif.trim().length < 5) { toast("Motif obligatoire (5 caractères min).", "err"); return; }
          API.post("/api/admin", { action: "verify", companyId: b.getAttribute("data-reject"), decision: "REJECTED", reason: motif.trim() }).then(function (r) {
            if (!r.ok) { toast(r.body.error || "Décision impossible.", "err"); return; }
            toast("Rejet enregistré et journalisé.", "ok");
            window.location.reload();
          });
        });
      });
    });

    /* Journal des affaires réel */
    API.get("/api/deals").then(function (r) {
      if (!r.ok) return;
      var body = get("affairesBody");
      body.innerHTML = "";
      (r.body.deals || []).forEach(function (d) {
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td><b>" + h(d.deal_number) + "</b></td>" +
          "<td>" + h(d.origin_city + " → " + d.destination_city) + "</td>" +
          "<td><span class='mode-badge'>" + modeIco(d.mode) + " " + h(modeFr(d.mode)) + "</span></td>" +
          "<td><b>" + euro(d.transport_amount) + " " + h(d.currency) + "</b></td>" +
          "<td style='color:var(--green);font-weight:700;'>" + euro(d.commission_amount) + "</td>" +
          "<td style='font-size:13px;'>" + h(new Date(d.confirmed_at).toLocaleDateString("fr-FR")) + "</td>" +
          "<td style='font-size:13px;'>" + h(d.carrier_name) + "</td>";
        body.appendChild(tr);
      });
      if (!(r.body.deals || []).length) {
        body.innerHTML = "<tr><td colspan='7' class='muted' style='padding:16px;'>Aucune affaire confirmée pour l'instant.</td></tr>";
      }
    });
  }
})();
