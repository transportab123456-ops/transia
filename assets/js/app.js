/* ============================================================
   Transia — JS partagé (navigation, toasts, modales, stockage)
   ============================================================ */

/* ---------- Navigation mobile ---------- */
(function () {
  var toggle = document.getElementById("navToggle");
  var links = document.getElementById("navLinks");
  if (toggle && links) {
    toggle.addEventListener("click", function () {
      links.classList.toggle("open");
    });
  }
})();

/* ---------- Année courante ---------- */
(function () {
  var y = document.getElementById("year");
  if (y) y.textContent = new Date().getFullYear();
})();

/* ---------- Modales ---------- */
function openModal(id) {
  var m = document.getElementById(id);
  if (m) m.classList.add("open");
}
function closeModal(id) {
  var m = document.getElementById(id);
  if (m) m.classList.remove("open");
}
document.addEventListener("click", function (e) {
  if (e.target.classList && e.target.classList.contains("modal-backdrop")) {
    e.target.classList.remove("open");
  }
  if (e.target.classList && e.target.classList.contains("modal-close")) {
    var b = e.target.closest(".modal-backdrop");
    if (b) b.classList.remove("open");
  }
});
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    document.querySelectorAll(".modal-backdrop.open").forEach(function (m) {
      m.classList.remove("open");
    });
  }
});

/* ---------- Toasts ---------- */
function toast(msg, type) {
  var zone = document.querySelector(".toast-zone");
  if (!zone) {
    zone = document.createElement("div");
    zone.className = "toast-zone";
    document.body.appendChild(zone);
  }
  var t = document.createElement("div");
  t.className = "toast " + (type || "ok");
  t.textContent = msg;
  zone.appendChild(t);
  setTimeout(function () {
    t.remove();
  }, 4200);
}

/* ---------- Stockage local (démo) ---------- */
var Store = {
  get: function (key, fallback) {
    try {
      var v = localStorage.getItem("transia_" + key);
      return v ? JSON.parse(v) : fallback;
    } catch (err) {
      return fallback;
    }
  },
  set: function (key, value) {
    try {
      localStorage.setItem("transia_" + key, JSON.stringify(value));
    } catch (err) { /* mode privé : la démo continue en mémoire */ }
  }
};

/* RFQ créées par l'utilisateur */
function getRfqsUser() {
  return Store.get("rfqs", []);
}
function saveRfqUser(rfq) {
  var list = getRfqsUser();
  list.unshift(rfq);
  Store.set("rfqs", list);
}
function getAllRfqs() {
  return getRfqsUser().concat(window.DB.rfqs);
}
function findRfq(ref) {
  var all = getAllRfqs();
  for (var i = 0; i < all.length; i++) {
    if (all[i].ref === ref) return all[i];
  }
  return null;
}

/* Offres (démo + saisies) */
function getOffres(ref) {
  var user = Store.get("offres", {});
  if (user[ref] && user[ref].length) return (window.DB.offres[ref] || []).concat(user[ref]);
  return window.DB.offres[ref] || [];
}
function saveOffre(ref, offre) {
  var all = Store.get("offres", {});
  if (!all[ref]) all[ref] = [];
  all[ref].push(offre);
  Store.set("offres", all);
}

/* Affaires confirmées */
function getAffaires() {
  return Store.get("affaires", []);
}
function saveAffaire(affaire) {
  var list = getAffaires();
  list.unshift(affaire);
  Store.set("affaires", list);
}

/* ---------- Helpers ---------- */
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatEuro(n) {
  return Number(n).toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + " €";
}

function nowFr() {
  var d = new Date();
  var p = function (v) { return String(v).padStart(2, "0"); };
  return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear() +
    " à " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function initials(nom) {
  return nom
    .split(/[\s-]+/)
    .slice(0, 2)
    .map(function (m) { return m.charAt(0).toUpperCase(); })
    .join("");
}

function badgeStatut(statut) {
  var map = {
    "OUVERTE": "badge-blue",
    "CONFIRMÉE": "badge-green",
    "CLOTURÉE": "badge-grey",
    "ACTIF": "badge-green",
    "VALIDÉ": "badge-blue",
    "À VÉRIFIER": "badge-amber",
    "INSCRIT": "badge-grey",
    "SUSPENDU": "badge-red"
  };
  return '<span class="badge ' + (map[statut] || "badge-grey") + '">' + escapeHtml(statut) + "</span>";
}

function modeIcon(mode) {
  return { "Routier": "🚚", "Maritime": "🚢", "Aérien": "✈️", "Multimodal": "🔗" }[mode] || "📦";
}

/* ---------- Validation simple de formulaire ---------- */
function markInvalid(el, invalid) {
  var field = el.closest(".field");
  if (field) field.classList.toggle("invalid", !!invalid);
}

function required(el) {
  var ok = el.value && String(el.value).trim() !== "";
  markInvalid(el, !ok);
  return ok;
}

function onRadioChange(name, onChange) {
  document.querySelectorAll('input[name="' + name + '"]').forEach(function (r) {
    r.addEventListener("change", function () { onChange(r.value); });
  });
}
