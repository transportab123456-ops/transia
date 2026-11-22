/* ============================================================
   Transia — assets/js/auth.js
   Page auth.html : connexion, inscription donneur d'ordre,
   inscription transporteur (statut « à vérifier »).
   ============================================================ */
(function () {
  function get(id) { return document.getElementById(id); }

  /* ---------- Vérification d'e-mail par lien (?verify=JETON) ---------- */
  var params = new URLSearchParams(window.location.search);
  var verifyToken = params.get("verify");
  if (verifyToken) {
    /* Nettoie l'URL pour qu'un rafraîchissement ne rejoue pas le jeton */
    window.history.replaceState({}, "", "auth.html");
    document.querySelector(".container").insertAdjacentHTML("afterbegin",
      "<div class='panel' id='verifyBox' style='text-align:center;'>" +
      "<h3 class='mt-0'>Vérification en cours…</h3>" +
      "<p id='verifyMsg' style='font-size:14px;color:#617795;'>Nous confirmons votre adresse e-mail.</p></div>");
    ("loginBox registerShipperBox registerCarrierBox alreadyBox").split(" ").forEach(function (id) {
      var el = get(id); if (el) el.classList.add("hidden");
    });

    API.post("/api/auth/tokens", { token: verifyToken }).then(function (r) {
      if (!r.ok) {
        get("verifyBox").innerHTML =
          "<h3 class='mt-0'> Lien invalide ou expiré</h3>" +
          "<p style='font-size:14px;color:#617795;'>" + escapeHtml(r.body.error || "Demandez un nouveau lien de vérification.") + "</p>" +
          "<button class='btn btn-outline' id='btnNewLink' style='margin-top:10px;'>Renvoyer le lien</button>";
        var b = get("btnNewLink");
        b.addEventListener("click", function () { window.location.href = "auth.html"; });
        return;
      }
      get("verifyBox").innerHTML =
        "<h3 class='mt-0'> Adresse e-mail confirmée</h3>" +
        "<p style='font-size:14px;color:#617795;'>" + escapeHtml(r.body.next || "Votre compte est actif.") + " Redirection…</p>";
      toast("E-mail vérifié — bienvenue sur Transia !", "ok");
      API.me(true);
      setTimeout(function () { redirectTo(r.body.user); }, 1200);
    }).catch(function () {
      get("verifyMsg").textContent = "Service injoignable — réessayez dans un instant.";
    });
    return; /* ne pas initialiser le reste de la page */
  }

  /* ---------- Réinitialisation par lien (?reset=JETON) ---------- */
  var resetToken = params.get("reset");
  if (resetToken) {
    /* Le jeton est retiré de l'URL pour qu'un rafraîchissement ne le rejoue pas */
    window.history.replaceState({}, "", "auth.html");
    ["loginBox", "registerShipperBox", "registerCarrierBox", "alreadyBox", "verifyPendingBox", "resetRequestBox"]
      .forEach(function (id) { var el = get(id); if (el) el.classList.add("hidden"); });
    get("resetConfirmBox").classList.remove("hidden");
    get("authTitle").textContent = "Nouveau mot de passe";
    get("authSubtitle").textContent = "Choisissez un mot de passe de 10 caractères minimum.";

    get("formResetConfirm").addEventListener("submit", function (e) {
      e.preventDefault();
      var p1 = get("rPassword").value;
      var p2 = get("rPassword2").value;
      if (p1.length < 10) { toast("Mot de passe : 10 caractères minimum.", "err"); return; }
      if (p1 !== p2) { toast("Les deux mots de passe ne correspondent pas.", "err"); return; }

      var btn = this.querySelector("button[type=submit]");
      btn.disabled = true; btn.textContent = "Enregistrement…";
      API.post("/api/auth/tokens", { action: "reset-confirm", token: resetToken, password: p1 }).then(function (r) {
        btn.disabled = false; btn.textContent = "Enregistrer le mot de passe";
        if (!r.ok) { toast(r.body.error || "Lien invalide ou expiré.", "err"); return; }
        get("resetConfirmBox").innerHTML =
          "<h3 class='mt-0'> Mot de passe modifié</h3>" +
          "<p style='font-size:14px;color:#617795;line-height:1.6;'>Vos sessions ouvertes ont été fermées. Vous pouvez vous connecter avec votre nouveau mot de passe.</p>" +
          "<a href='auth.html' class='btn btn-primary btn-block btn-lg' style='margin-top:14px;'>Se connecter</a>";
      }).catch(function () {
        btn.disabled = false; btn.textContent = "Enregistrer le mot de passe";
        toast("Service injoignable.", "err");
      });
    });
    return; /* page dédiée : on n'initialise pas le reste */
  }

  /* ---------- Encart « vérifiez votre boîte mail » ---------- */
  function showVerifyPending(email) {
    ("loginBox registerShipperBox registerCarrierBox").split(" ").forEach(function (id) {
      var el = get(id); if (el) el.classList.add("hidden");
    });
    var box = get("verifyPendingBox");
    box.classList.remove("hidden");
    get("vpEmail").textContent = email;
    get("authTitle").textContent = "Vérifiez votre e-mail";
    get("authSubtitle").textContent = "Un lien de vérification vous attend dans votre boîte mail (valable 24 heures).";

    get("btnResendVerify").onclick = function () {
      var btn = this;
      btn.disabled = true; btn.textContent = "Envoi…";
      API.post("/api/auth/tokens", { action: "resend", email: email }).then(function (r) {
        btn.disabled = false; btn.textContent = "Renvoyer le lien";
        toast((r.ok && r.body.message) || "Demande envoyée.", r.ok ? "ok" : "err");
      }).catch(function () { btn.disabled = false; btn.textContent = "Renvoyer le lien"; toast("Service injoignable.", "err"); });
    };
    get("btnChangeEmail").onclick = function () { show("login"); };
  }

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

  /* ---------- Demande de réinitialisation ---------- */
  get("btnForgot").addEventListener("click", function () {
    ["loginBox", "registerShipperBox", "registerCarrierBox", "alreadyBox", "verifyPendingBox"]
      .forEach(function (id) { var el = get(id); if (el) el.classList.add("hidden"); });
    get("resetRequestBox").classList.remove("hidden");
    get("authTitle").textContent = "Mot de passe oublié";
    get("authSubtitle").textContent = "Un lien de réinitialisation valable 1 heure sera envoyé.";
  });

  get("btnBackToLogin").addEventListener("click", function () {
    get("resetRequestBox").classList.add("hidden");
    show("login");
  });

  get("formResetRequest").addEventListener("submit", function (e) {
    e.preventDefault();
    var email = get("rEmail").value.trim().toLowerCase();
    if (!email) { toast("E-mail requis.", "err"); return; }

    var btn = this.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "Envoi…";
    API.post("/api/auth/tokens", { action: "reset-request", email: email }).then(function (r) {
      btn.disabled = false; btn.textContent = "Recevoir le lien";
      if (!r.ok) { toast(r.body.error || "Demande impossible.", "err"); return; }
      get("resetRequestBox").innerHTML =
        "<h3 class='mt-0'> Demande enregistrée</h3>" +
        "<p style='font-size:14px;color:#617795;line-height:1.6;'>Si un compte correspond à <b>" + escapeHtml(email) + "</b>, un lien de réinitialisation vient d'être envoyé (valable 1 heure).</p>" +
        "<a href='auth.html' class='btn btn-outline' style='margin-top:14px;'>Revenir à la connexion</a>";
    }).catch(function () {
      btn.disabled = false; btn.textContent = "Recevoir le lien";
      toast("Service injoignable.", "err");
    });
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
      if (!r.ok) {
        if (r.body.code === "EMAIL_NOT_VERIFIED") {
          toast(r.body.error || "E-mail non vérifié.", "err");
          showVerifyPending(email);
          return;
        }
        toast(r.body.error || "Connexion impossible.", "err"); return;
      }
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
      password: get("sPassword").value,
      termsAccepted: get("sTerms").checked,
      termsVersion: (window.TRANSIA_TERMS || {}).shipper || ""
    };
    if (!payload.companyName || !payload.firstName || !payload.lastName || !payload.email || !payload.password) {
      toast("Merci de compléter les champs obligatoires.", "err"); return;
    }
    if (!get("sTerms").checked) { toast("Merci d'accepter les conditions générales.", "err"); return; }
    API.post("/api/auth/register", payload).then(function (r) {
      if (!r.ok) { toast(r.body.error || "Inscription impossible.", "err"); return; }
      if (r.body.requiresEmailVerification) {
        showVerifyPending(payload.email);
        return;
      }
      API.me(true);
      toast("Compte créé — bienvenue " + payload.firstName + " !", "ok");
      setTimeout(function () { window.location.href = "demande.html"; }, 700);
    }).catch(function () { toast("Service injoignable.", "err"); });
  });

  /* ---------- Inscription transporteur ---------- */
  var modesBox = get("cModes");
  [["ROAD", "Routier "], ["SEA", "Maritime "], ["AIR", "Aérien "], ["MULTIMODAL", "Multimodal "]].forEach(function (m) {
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
      modes: modes,
      termsAccepted: get("cTerms").checked,
      termsVersion: (window.TRANSIA_TERMS || {}).carrier || ""
    };
    if (!payload.companyName || !payload.firstName || !payload.lastName || !payload.email || !payload.password) {
      toast("Merci de compléter les champs obligatoires.", "err"); return;
    }
    if (!modes.length) { toast("Sélectionnez au moins un mode de transport.", "err"); return; }
    if (!get("cTerms").checked) { toast("Merci d'accepter les conditions d'accès et d'intermédiation.", "err"); return; }

    API.post("/api/carriers", payload).then(function (r) {
      if (!r.ok) { toast(r.body.error || "Inscription impossible.", "err"); return; }
      if (r.body.requiresEmailVerification) {
        showVerifyPending(payload.email);
        return;
      }
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
