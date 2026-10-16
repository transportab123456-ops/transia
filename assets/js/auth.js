/* ============================================================
   Transia — assets/js/auth.js
   Page auth.html : connexion, inscription donneur d'ordre,
   inscription transporteur (statut « à vérifier »).
   ============================================================ */
(function () {
  function get(id) { return document.getElementById(id); }

  var tabs = {
    login: { box: "loginBox", btn: "tabLogin", title: "Connexion à Transia", subtitle: "Accédez à votre espace : donneur d'ordre, transporteur ou administration." },
    shipper: { box: "registerShipperBox", btn: "tabRegisterShipper", title: "Créer un compte donneur d'ordre", subtitle: "Publiez vos demandes de cotation et recevez des offres concurrentes à l'aveugle." },
    carrier: { box: "registerCarrierBox", btn: "tabRegisterCarrier", title: "Créer un compte transporteur", subtitle: "Consultez les demandes ouvertes et déposez vos offres — vérification plateforme incluse." }
  };

  function show(name) {
    Object.keys(tabs).forEach(function (k) {
      get(tabs[k].box).classList.toggle("hidden", k !== name);
      get(tabs[k].btn).classList.toggle("btn-primary", k === name);
      get(tabs[k].btn).classList.toggle("btn-outline", k !== name);
    });
    get("authTitle").textContent = tabs[name].title;
    get("authSubtitle").textContent = tabs[name].subtitle;
  }

  Object.keys(tabs).forEach(function (k) {
    get(tabs[k].btn).addEventListener("click", function () { show(k); });
  });

  /* ---------- Session existante ---------- */
  API.me().then(function (user) {
    if (user) {
      get("alreadyBox").classList.remove("hidden");
      get("alreadyInfo").innerHTML =
        "<b>" + escapeHtml(user.first_name + " " + user.last_name) + "</b> (" + escapeHtml(user.email) + ")<br />" +
        (API.isPlatform(user) ? "Compte plateforme — " : API.isCarrier(user) ? "Compte transporteur — " : "Donneur d'ordre — ") +
        "rôle : " + escapeHtml(user.role);
      get("linkEspace").href = API.isCarrier(user) ? "transporteur.html" : API.isPlatform(user) ? "admin.html" : "espace-donneur.html";
    } else {
      show("login");
    }
  });

  get("btnLogout").addEventListener("click", function () {
    API.post("/api/auth/me").then(function () {
      toast("Session fermée.", "ok");
      setTimeout(function () { window.location.reload(); }, 600);
    });
  });

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- Connexion ---------- */
  get("formLogin").addEventListener("submit", function (e) {
    e.preventDefault();
    var email = get("lEmail").value.trim().toLowerCase();
    var password = get("lPassword").value;
    if (!email || !password) { toast("E-mail et mot de passe requis.", "err"); return; }

    API.post("/api/auth/login", { email: email, password: password }).then(function (r) {
      if (!r.ok) { toast(r.body.error || "Connexion impossible.", "err"); return; }
      API.me(true);
      redirectTo(r.body.user);
    }).catch(function () { toast("Service injoignable.", "err"); });
  });

  /* ---------- Inscription donneur d'ordre ---------- */
  get("formRegisterShipper").addEventListener("submit", function (e) {
    e.preventDefault();
    var payload = {
      companyName: get("sCompany").value.trim(),
      countryCode: get("sCountry").value.trim().toUpperCase(),
      firstName: get("sFirst").value.trim(),
      lastName: get("sLast").value.trim(),
      email: get("sEmail").value.trim().toLowerCase(),
      password: get("sPassword").value
    };
    if (!payload.companyName || !payload.firstName || !payload.lastName || !payload.email || !payload.password) {
      toast("Merci de compléter les champs obligatoires.", "err"); return;
    }
    API.post("/api/auth/register", payload).then(function (r) {
      if (!r.ok) { toast(r.body.error || "Inscription impossible.", "err"); return; }
      API.me(true);
      toast("Compte créé — bienvenue " + payload.firstName + " !", "ok");
      setTimeout(function () { window.location.href = "demande.html"; }, 700);
    }).catch(function () { toast("Service injoignable.", "err"); });
  });

  /* ---------- Inscription transporteur ---------- */
  var modesBox = get("cModes");
  [["ROAD", "Routier 🚚"], ["SEA", "Maritime 🚢"], ["AIR", "Aérien ✈️"], ["MULTIMODAL", "Multimodal 🔗"]].forEach(function (m) {
    var label = document.createElement("label");
    label.style.cssText = "display:flex;gap:7px;align-items:center;font-size:14px;font-weight:500;";
    label.innerHTML = "<input type='checkbox' name='cMode' value='" + m[0] + "' style='width:auto;' /> " + m[1];
    modesBox.appendChild(label);
  });

  get("formRegisterCarrier").addEventListener("submit", function (e) {
    e.preventDefault();
    var modes = [];
    document.querySelectorAll("input[name='cMode']:checked").forEach(function (c) { modes.push(c.value); });
    var payload = {
      companyName: get("cCompany").value.trim(),
      countryCode: get("cCountry").value.trim().toUpperCase(),
      firstName: get("cFirst").value.trim(),
      lastName: get("cLast").value.trim(),
      email: get("cEmail").value.trim().toLowerCase(),
      password: get("cPassword").value,
      taxId: get("cTax").value.trim() || null,
      vatNumber: get("cVat").value.trim() || null,
      modes: modes
    };
    if (!payload.companyName || !payload.firstName || !payload.lastName || !payload.email || !payload.password) {
      toast("Merci de compléter les champs obligatoires.", "err"); return;
    }
    if (!modes.length) { toast("Sélectionnez au moins un mode de transport.", "err"); return; }

    API.post("/api/carriers", payload).then(function (r) {
      if (!r.ok) { toast(r.body.error || "Inscription impossible.", "err"); return; }
      API.me(true);
      toast("Compte créé — statut : à vérifier par la plateforme.", "ok");
      setTimeout(function () { window.location.href = "transporteur.html"; }, 900);
    }).catch(function () { toast("Service injoignable.", "err"); });
  });

  function redirectTo(user) {
    if (API.isPlatform(user)) window.location.href = "admin.html";
    else if (API.isCarrier(user)) window.location.href = "transporteur.html";
    else window.location.href = "espace-donneur.html";
  }
})();
