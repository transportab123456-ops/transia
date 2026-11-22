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
        .then(function (r) { return (r.ok && r.body.user) || null; })
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
