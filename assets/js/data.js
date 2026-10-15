/* ============================================================
   Transia — Données de démonstration (prototype statique)
   Issues du cahier des charges v0.1
   ============================================================ */

window.DB = {
  /* ---------- Incoterms® 2020 (les 11) ---------- */
  incoterms: [
    { code: "EXW", libelle: "EXW — À l'usine (rendu magasin)" },
    { code: "FCA", libelle: "FCA — Franco transporteur" },
    { code: "CPT", libelle: "CPT — Port payé jusqu'à destination" },
    { code: "CIP", libelle: "CIP — Port payé, assurance comprise" },
    { code: "DAP", libelle: "DAP — Rendu à destination (non déchargé)" },
    { code: "DPU", libelle: "DPU — Rendu déchargé" },
    { code: "DDP", libelle: "DDP — Rendu droits payés" },
    { code: "FAS", libelle: "FAS — Franco le long du navire" },
    { code: "FOB", libelle: "FOB — Franco à bord" },
    { code: "CFR", libelle: "CFR — Coût et fret" },
    { code: "CIF", libelle: "CIF — Coût, assurance et fret" }
  ],

  /* ---------- Modes ---------- */
  modes: ["Routier", "Maritime", "Aérien", "Multimodal"],

  /* ---------- Motifs de refus (section 14 + module donneur) ---------- */
  motifsRefus: [
    "Prix trop élevé",
    "Délai",
    "Besoin annulé",
    "Transport déjà attribué",
    "Modification du besoin",
    "Autre"
  ],

  /* ---------- RFQ de démonstration ---------- */
  rfqs: [
    {
      ref: "RFQ-00030",
      origine: { pays: "France", ville: "Bordeaux", cp: "33000", lieu: "Zone portuaire, quai 4", date: "12/07/2026" },
      dest: { pays: "Suisse", ville: "Genève", cp: "1201", lieu: "Entrepôt client, route de Meyrin" },
      mode: "Routier",
      marchandise: { type: "Palettes", desc: "Pièces détachées automobiles", colis: 14, palettes: 7, poids: "3 200 kg", volume: "18 m³", dims: "120x80x140 cm" },
      incoterm: "DAP",
      dangereuse: false,
      statut: "CONFIRMÉE",
      reponses: 4,
      prixRetenu: 1450
    },
    {
      ref: "RFQ-00031",
      origine: { pays: "France", ville: "Lyon", cp: "69007", lieu: "Entrepôt Rhône-Alpes Logistique", date: "28/08/2026" },
      dest: { pays: "Maroc", ville: "Casablanca", cp: "20000", lieu: "Zone franche, lot 23" },
      mode: "Routier",
      marchandise: { type: "Palettes", desc: "Équipements électroniques", colis: 18, palettes: 9, poids: "4 100 kg", volume: "26 m³", dims: "120x100x160 cm" },
      incoterm: "CIP",
      dangereuse: false,
      statut: "OUVERTE",
      reponses: 4
    },
    {
      ref: "RFQ-00032",
      origine: { pays: "France", ville: "Marseille", cp: "13002", lieu: "Terminal Port Sud, poste 12", date: "02/09/2026" },
      dest: { pays: "Maroc", ville: "Tanger", cp: "90000", lieu: "Tanger Med, terminal Q1" },
      mode: "Maritime",
      marchandise: { type: "Conteneur", desc: "Mobilier et textiles", colis: 240, palettes: 20, poids: "9 800 kg", volume: "52 m³", dims: "40' HC" },
      incoterm: "FOB",
      dangereuse: false,
      statut: "OUVERTE",
      reponses: 3
    },
    {
      ref: "RFQ-00033",
      origine: { pays: "France", ville: "Paris", cp: "95000", lieu: "CDG Cargo, hall 3", date: "30/08/2026" },
      dest: { pays: "Émirats arabes unis", ville: "Dubaï", cp: "00000", lieu: "DWC Free Zone" },
      mode: "Aérien",
      marchandise: { type: "Colis", desc: "Échantillons pharmaceutiques (non ADR)", colis: 6, palettes: 1, poids: "450 kg", volume: "3,2 m³", dims: "200x120x160 cm" },
      incoterm: "CIP",
      dangereuse: false,
      statut: "OUVERTE",
      reponses: 2
    },
    {
      ref: "RFQ-00034",
      origine: { pays: "France", ville: "Lille", cp: "59000", lieu: "Entrepôt Lesquin", date: "05/09/2026" },
      dest: { pays: "Belgique", ville: "Bruxelles", cp: "1000", lieu: "Entrepôt Zone Wavre" },
      mode: "Routier",
      marchandise: { type: "Palettes", desc: "Produits d'entretien", colis: 9, palettes: 3, poids: "1 100 kg", volume: "7 m³", dims: "120x80x120 cm" },
      incoterm: "DAP",
      dangereuse: true,
      dangerInfo: { onu: "UN 1950", designation: "Aérosols", classe: "Classe 2.1", groupe: "Groupe des emballages II", quantite: "3 palettes", doc: "FDS fournie" },
      statut: "OUVERTE",
      reponses: 0
    },
    {
      ref: "RFQ-00035",
      origine: { pays: "France", ville: "Le Havre", cp: "76600", lieu: "Port, terminal 20' quai Est", date: "08/09/2026" },
      dest: { pays: "Pays-Bas", ville: "Rotterdam", cp: "3011", lieu: "Maasvlakte II" },
      mode: "Maritime",
      marchandise: { type: "Conteneur", desc: "Machines industrielles", colis: 4, palettes: 0, poids: "17 500 kg", volume: "28 m³", dims: "20'" },
      incoterm: "CFR",
      dangereuse: false,
      statut: "OUVERTE",
      reponses: 0
    },
    {
      ref: "RFQ-00036",
      origine: { pays: "France", ville: "Toulouse", cp: "31000", lieu: "Blagnac, zone aéroportuaire", date: "12/09/2026" },
      dest: { pays: "Italie", ville: "Milan", cp: "20090", lieu: "Entrepôt Segrate" },
      mode: "Multimodal",
      marchandise: { type: "Colis", desc: "Composants aéronautiques", colis: 12, palettes: 2, poids: "640 kg", volume: "4 m³", dims: "—" },
      incoterm: "FCA",
      dangereuse: false,
      statut: "OUVERTE",
      reponses: 0
    }
  ],

  /* ---------- Offres anonymisées par RFQ (cotations à l'aveugle) ---------- */
  offres: {
    "RFQ-00031": [
      { lettre: "A", prix: 2350, devise: "EUR", delai: "5 jours", validite: "12/09/2026", conditions: "Port payé. TVA incluse. Escortes non prévues.", services: "Manutention départ incluse", conforme: true, qualite: { statut: "Transporteur vérifié", note: "4,6 / 5", licence: "Licence communautaire active", experience: "9 ans d'activité", affaires: "210 affaires sur la plateforme" } },
      { lettre: "B", prix: 2180, devise: "EUR", delai: "6 jours", validite: "10/09/2026", conditions: "Franco départ. Assurance marchandise standard incluse.", services: "—", conforme: true, qualite: { statut: "Transporteur vérifié", note: "4,3 / 5", licence: "Licence communautaire active", experience: "6 ans d'activité", affaires: "145 affaires sur la plateforme" } },
      { lettre: "C", prix: 2420, devise: "EUR", delai: "4 jours", validite: "15/09/2026", conditions: "Hors manutention à l'arrivée — périmètre non comparable.", services: "Livraison J+1 express", conforme: false, motifNonConformite: "Périmètre différent : manutention d'arrivée exclue. Offre écartée de la recommandation.", qualite: { statut: "Transporteur vérifié", note: "4,8 / 5", licence: "Licence communautaire active", experience: "12 ans d'activité", affaires: "390 affaires sur la plateforme" } },
      { lettre: "D", prix: 2090, devise: "EUR", delai: "6 jours", validite: "11/09/2026", conditions: "Port payé, TVA incluse. Assurance incluse (valeur déclarée 60 000 €).", services: "Groupage hebdomadaire, suivi inclus", conforme: true, qualite: { statut: "Transporteur vérifié", note: "4,7 / 5", licence: "Licence communautaire active", experience: "11 ans d'activité", affaires: "305 affaires sur la plateforme" } }
    ],
    "RFQ-00032": [
      { lettre: "A", prix: 3890, devise: "EUR", delai: "6 jours", validite: "18/09/2026", conditions: "FCL 40' HC, chargement complet. Transitaire désigné côté arrivée.", services: "Déballastage inclus", conforme: true, qualite: { statut: "Transporteur vérifié", note: "4,5 / 5", licence: "Licence active", experience: "14 ans d'activité", affaires: "260 affaires sur la plateforme" } },
      { lettre: "B", prix: 3650, devise: "EUR", delai: "8 jours", validite: "16/09/2026", conditions: "FCL 40' HC. Surestaries à la charge du donneur d'ordre.", services: "—", conforme: true, qualite: { statut: "Transporteur vérifié", note: "4,2 / 5", licence: "Licence active", experience: "8 ans d'activité", affaires: "175 affaires sur la plateforme" } },
      { lettre: "C", prix: 3980, devise: "EUR", delai: "5 jours", validite: "20/09/2026", conditions: "LCL groupé — délai plus court, escale ajoutée.", services: "Assurance étendue incluse", conforme: false, motifNonConformite: "Mode d'acheminement différent (LCL vs FCL) : périmètre non comparable.", qualite: { statut: "Transporteur vérifié", note: "4,6 / 5", licence: "Licence active", experience: "10 ans d'activité", affaires: "240 affaires sur la plateforme" } }
    ],
    "RFQ-00033": [
      { lettre: "A", prix: 1870, devise: "EUR", delai: "48 h", validite: "05/09/2026", conditions: "Port aérien, groupage daily. Douane à la charge du donneur d'ordre.", services: "Frigorifique non requis", conforme: true, qualite: { statut: "Transporteur vérifié", note: "4,9 / 5", licence: "AWB actif", experience: "15 ans d'activité", affaires: "512 affaires sur la plateforme" } },
      { lettre: "B", prix: 1750, devise: "EUR", delai: "72 h", validite: "03/09/2026", conditions: "Port aérien. Escale à Doha.", services: "—", conforme: true, qualite: { statut: "Transporteur vérifié", note: "4,4 / 5", licence: "AWB actif", experience: "7 ans d'activité", affaires: "160 affaires sur la plateforme" } }
    ],
    "RFQ-00030": [
      { lettre: "A", prix: 1450, devise: "EUR", delai: "3 jours", validite: "20/07/2026", conditions: "Port payé. Assurance incluse.", services: "Attente 1 h incluse", conforme: true, qualite: { statut: "Transporteur vérifié", note: "4,7 / 5", licence: "Licence communautaire active", experience: "11 ans d'activité", affaires: "305 affaires sur la plateforme" } }
    ]
  },

  /* ---------- Transporteurs (exemples) ---------- */
  transporteurs: [
    { id: "T-001", nom: "TransAtlas Logistics", pays: "France", ville: "Lyon", modes: ["Routier", "Multimodal"], lignes: "FR · BE · DE · ES · MA · CH", statut: "ACTIF", note: "4,7 / 5", affaires: 305, depuis: "2022", immat: "FR-812 449 302", tva: "FR 42 812449302", contact: "Sophie Marchand", fonction: "Responsable commercial", tel: "+33 4 72 00 11 22", email: "smarchand@transatlas-logistics.example", site: "transatlas-logistics.example" },
    { id: "T-002", nom: "MedFret Shipping", pays: "France", ville: "Marseille", modes: ["Maritime"], lignes: "FR · MA · TN · DZ · IT", statut: "ACTIF", note: "4,5 / 5", affaires: 260, depuis: "2021", immat: "FR-901 774 118", tva: "FR 61 901774118", contact: "Karim Belkacem", fonction: "Directeur exploitation", tel: "+33 4 91 55 60 70", email: "k.belkacem@medfret.example", site: "medfret.example" },
    { id: "T-003", nom: "EuroBridge Transport", pays: "Belgique", ville: "Anvers", modes: ["Routier", "Maritime"], lignes: "BE · FR · NL · DE · GB", statut: "VALIDÉ", note: "4,3 / 5", affaires: 145, depuis: "2023", immat: "BE-0744.882.310", tva: "BE 0744882310", contact: "Erik Janssens", fonction: "Sales manager", tel: "+32 3 400 12 34", email: "e.janssens@eurobridge.example", site: "eurobridge.example" },
    { id: "T-004", nom: "SkyLine Cargo", pays: "France", ville: "Roissy", modes: ["Aérien"], lignes: "FR · AE · US · CN · HK · SG", statut: "ACTIF", note: "4,9 / 5", affaires: 512, depuis: "2020", immat: "FR-552 019 874", tva: "FR 09 552019874", contact: "Amélie Roux", fonction: "Key account manager", tel: "+33 1 48 17 90 00", email: "a.roux@skylinecraft.example", site: "skylinecraft.example" },
    { id: "T-005", nom: "NorthSea Lines", pays: "Pays-Bas", ville: "Rotterdam", modes: ["Maritime", "Multimodal"], lignes: "NL · FR · BE · DE · GB · CN", statut: "À VÉRIFIER", note: "—", affaires: 0, depuis: "2026", immat: "NL-8612.44.902", tva: "NL 861244902B01", contact: "Pieter de Vries", fonction: "Managing director", tel: "+31 10 240 55 66", email: "p.devries@northsealines.example", site: "northsealines.example", justificatifs: ["Immatriculation", "Assurance RC maritime"] },
    { id: "T-006", nom: "Iberia Freight", pays: "Espagne", ville: "Barcelone", modes: ["Routier"], lignes: "ES · FR · PT · IT · MA", statut: "À VÉRIFIER", note: "—", affaires: 0, depuis: "2026", immat: "ES-A-88 412 901", tva: "ES B-88412901", contact: "Carlos Ferrer", fonction: "Jefe de operaciones", tel: "+34 93 400 11 22", email: "c.ferrer@iberiafreight.example", site: "iberiafreight.example", justificatifs: ["Licence communautaire", "Carte verte assurance"] },
    { id: "T-007", nom: "Maghreb Express", pays: "Maroc", ville: "Casablanca", modes: ["Routier", "Maritime"], lignes: "MA · FR · ES · TN", statut: "INSCRIT", note: "—", affaires: 0, depuis: "2026", immat: "MA-RC 442 118", tva: "ICE 002441887000042", contact: "Youssef Amrani", fonction: "Gérant", tel: "+212 522 40 11 22", email: "y.amrani@maghrebexpress.example", site: "maghrebexpress.example", justificatifs: [] },
    { id: "T-008", nom: "Alpina Trans", pays: "Italie", ville: "Milan", modes: ["Routier", "Multimodal"], lignes: "IT · FR · CH · DE · AT", statut: "SUSPENDU", note: "3,9 / 5", affaires: 88, depuis: "2023", immat: "IT-MI-998 441 220", tva: "IT 09984412201", contact: "Giulia Bianchi", fonction: "Amministratrice", tel: "+39 02 8901 4455", email: "g.bianchi@alpinatrans.example", site: "alpinatrans.example", motifSuspension: "Assurance expirée — justificatif non fourni" }
  ],

  /* ---------- Tableau de bord stratégique par pays (section 18) ---------- */
  pays: [
    { pays: "France", actif: true, entreprises: 1250, transporteurs: 320, contacts: 1800, cotations: 4500, affaires: 760, maturite: 96 },
    { pays: "Belgique", actif: false, entreprises: 180, transporteurs: 95, contacts: 310, cotations: 420, affaires: 60, maturite: 62 },
    { pays: "Italie", actif: false, entreprises: 130, transporteurs: 72, contacts: 240, cotations: 310, affaires: 48, maturite: 54 },
    { pays: "Espagne", actif: false, entreprises: 290, transporteurs: 110, contacts: 460, cotations: 650, affaires: 92, maturite: 71 }
  ]
};
