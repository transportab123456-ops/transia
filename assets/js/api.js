/* ============================================================
   Transia — assets/js/api.js
   Client de l'API réelle (mêmes origines que le site).
   - session : GET /api/auth/me (cookie httpOnly, jamais stocké en JS)
   - helper GET/POST JSON avec gestion d'erreur propre
   - barre d'authentification injectée dans la nav de chaque page
   Si l'API est injoignable (statique ouvert en local, démo), les
   pages restent utilisables en mode démonstration.
   ============================================================ */

var API = (function () {
  var _mePromise = null;

  function request(method, path, body) {
    return fetch(path, {
      method: method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, ok: res.ok, body: data };
      });
    });
  }

  function get(path) { return request("GET", path); }
  function post(path, body) { return request("POST", path, body || {}); }

  /* Session courante (cache promesse) */
  function me(force) {
    if (!_mePromise || force) {
      _mePromise = get("/api/auth/me")
        .then(function (r) {
          if (r.ok && r.body.terms && r.body.terms.required) termsGate(r.body.terms);
          return (r.ok && r.body.user) || null;
        })
        .catch(function () { return null; });
    }
    return _mePromise;
  }

  function isShipper(u) { return u && (u.role === "SHIPPER_USER" || u.role === "SHIPPER_ADMIN"); }
  function isCarrier(u) { return u && (u.role === "CARRIER_USER" || u.role === "CARRIER_ADMIN"); }
  function isPlatform(u) {
    return u && ["PLATFORM_OPERATIONS", "PLATFORM_FINANCE", "PLATFORM_ADMIN", "SUPER_ADMIN"].indexOf(u.role) !== -1;
  }

  /* Codage des modes (libellé FR ↔ code API) */
  var MODES = { "Routier": "ROAD", "Maritime": "SEA", "Aérien": "AIR", "Multimodal": "MULTIMODAL" };
  var MODES_FR = { "ROAD": "Routier", "SEA": "Maritime", "AIR": "Aérien", "MULTIMODAL": "Multimodal" };
  function modeCode(fr) { return MODES[fr] || String(fr || "").toUpperCase(); }
  function modeLabel(code) { return MODES_FR[code] || code || ""; }

  /* Nom de pays → code ISO2 (référentiel local de la démo) */
  function countryCode(nom) {
    var ref = window.REF || { pays: [] };
    var found = ref.pays.filter(function (p) { return p.n === nom; })[0];
    return found ? found.c : null;
  }
  function countryName(iso) {
    var ref = window.REF || { pays: [] };
    var found = ref.pays.filter(function (p) { return p.c === iso; })[0];
    return found ? found.n : iso || "—";
  }

  /* Extrait un nombre d'un champ texte ("4 800 kg" → 4800) */
  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    var n = parseFloat(String(v).replace(",", ".").replace(/[^\d.]/g, ""));
    return isFinite(n) ? n : null;
  }

  /* ---------- Barre d'authentification (nav de chaque page) ---------- */
  function renderAuthBar() {
    var zone = document.querySelector(".nav-actions");
    if (!zone) return;
    var old = document.getElementById("apiAuthBar");
    if (old) old.remove();

    me().then(function (user) {
      var div = document.createElement("span");
      div.id = "apiAuthBar";
      div.style.cssText = "display:inline-flex;gap:10px;align-items:center;";
      if (!user) {
        div.innerHTML = '<a href="auth.html" class="btn btn-ghost">Connexion</a>';
      } else {
        var role = isPlatform(user) ? "Plateforme" : isCarrier(user) ? "Transporteur" : "Donneur d'ordre";
        div.innerHTML =
          "<span style='font-size:13px;color:#617795;'> " +
          escapeHtmlHtml(user.first_name || user.email) +
          " <span class='badge badge-blue'>" + role + "</span></span>" +
          "<button class='btn btn-ghost' id='apiLogout'>Déconnexion</button>";
      }
      zone.appendChild(div);
      var out = document.getElementById("apiLogout");
      if (out) {
        out.addEventListener("click", function () {
          post("/api/auth/me").then(function () {
            _mePromise = null;
            window.location.reload();
          });
        });
      }
    });
  }

  function escapeHtmlHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* Bannière hors session (données d'exemple) */
  function demoBanner() {
    if (document.getElementById("apiDemoBanner")) return;
    var b = document.createElement("div");
    b.id = "apiDemoBanner";
    b.style.cssText = "background:#fff7e6;border-bottom:1px solid #f5d78e;color:#96650f;font-size:13px;padding:8px 16px;text-align:center;";
    b.innerHTML = "Vous consultez des données d'exemple. " +
      "<a href='auth.html' style='color:#96650f;font-weight:700;'>Connectez-vous</a> pour utiliser la plateforme.";
    var nav = document.querySelector(".nav");
    if (nav && nav.parentNode) nav.parentNode.insertBefore(b, nav.nextSibling);
  }

  /* ---------- Acceptation des CGU sur session déjà ouverte ---------- */
  /* Blocage plein écran, non fermable : une session ouverte avant la
     preuve versionnée ne doit pas continuer sans accepter. */
  function termsGate(terms) {
    if (document.getElementById("termsGate")) return;

    var box = document.createElement("div");
    box.id = "termsGate";
    box.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(11,33,48,.72);display:flex;align-items:center;justify-content:center;padding:20px;";
    box.innerHTML =
      "<div style='background:#fff;border-radius:14px;max-width:520px;width:100%;padding:28px;box-shadow:0 24px 60px rgba(0,0,0,.28);'>" +
        "<h2 style='margin:0 0 10px;font-size:20px;color:#0b2130;'>Conditions générales mises à jour</h2>" +
        "<p style='margin:0 0 16px;font-size:14px;line-height:1.6;color:#42586b;'>Pour continuer à utiliser votre compte, acceptez la version " +
          escapeHtmlHtml(terms.version) + " des conditions.</p>" +
        "<label style='display:flex;gap:9px;align-items:flex-start;font-size:14px;line-height:1.5;color:#0b2130;'>" +
          "<input type='checkbox' id='termsGateCheck' style='width:auto;margin-top:3px;' />" +
          "<span>J'accepte les <a href='" + escapeHtmlHtml(terms.url) + "' target='_blank' rel='noopener' style='color:#0a6076;'>" +
            escapeHtmlHtml(terms.label) + "</a> (version " + escapeHtmlHtml(terms.version) + ").</span>" +
        "</label>" +
        "<p id='termsGateErr' style='margin:10px 0 0;font-size:13px;color:#b3261e;display:none;'>Merci de cocher la case pour continuer.</p>" +
        "<button type='button' id='termsGateBtn' style='margin-top:18px;width:100%;padding:12px 16px;border:none;border-radius:9px;background:#0a6076;color:#fff;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;'>Accepter et continuer</button>" +
      "</div>";
    document.body.appendChild(box);

    var check = document.getElementById("termsGateCheck");
    var err = document.getElementById("termsGateErr");
    var btn = document.getElementById("termsGateBtn");

    btn.addEventListener("click", function () {
      if (!check.checked) { err.style.display = "block"; return; }
      btn.disabled = true; btn.textContent = "Enregistrement…";

      post("/api/auth/me", { termsAccepted: true, termsVersion: terms.version }).then(function (r) {
        if (!r.ok) {
          btn.disabled = false; btn.textContent = "Accepter et continuer";
          err.textContent = r.body.error || "Enregistrement impossible. Réessayez.";
          err.style.display = "block";
          return;
        }
        _mePromise = null;
        window.location.reload();
      }).catch(function () {
        btn.disabled = false; btn.textContent = "Accepter et continuer";
        err.textContent = "Service injoignable. Réessayez.";
        err.style.display = "block";
      });
    });
  }

  return {
    get: get, post: post, me: me,
    isShipper: isShipper, isCarrier: isCarrier, isPlatform: isPlatform,
    modeCode: modeCode, modeLabel: modeLabel,
    countryCode: countryCode, countryName: countryName, num: num,
    renderAuthBar: renderAuthBar, demoBanner: demoBanner
  };
})();

/* Injection automatique dans toutes les pages */
API.renderAuthBar();
