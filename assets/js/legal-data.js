/* ============================================================
   Transia — assets/js/legal-data.js
   Données juridiques par pays et par convention internationale.
   Chaque fiche renvoie à ses sources officielles.
   Information documentaire — ne constitue pas un conseil juridique.
   ============================================================ */
(function () {
  "use strict";

  var MISE_A_JOUR = "Novembre 2026";

  /* ---------- Les trois qualifications possibles ---------- */
  var QUALIFICATIONS = [
    {
      key: "courtier",
      titre: "Courtier / mandataire transparent",
      ton: "low",
      indice: "Simple rapprochement d'une offre et d'une demande ; le contrat de transport est conclu directement entre le chargeur et le transporteur, qui fixent librement le prix.",
      consequences: [
        "Pas d'inscription à un registre de transport en France",
        "Responsabilité limitée à la mise en relation",
        "Commission facturée comme une prestation d'entremise autonome",
        "TVA sur la seule commission"
      ]
    },
    {
      key: "commissionnaire",
      titre: "Commissionnaire de transport",
      ton: "high",
      indice: "La plateforme organise et fait exécuter le transport sous sa responsabilité et en son nom, choisit les transporteurs et fixe le prix.",
      consequences: [
        "Inscription au registre des commissionnaires de transport (France, R. 1422-1 C. transports)",
        "Capacité professionnelle et honorabilité",
        "Obligation de résultat sur la bonne fin du transport",
        "Risque de requalification TVA : assiette = prix total du transport"
      ]
    },
    {
      key: "operateur-numerique",
      titre: "Opérateur de service numérique de mise en relation",
      ton: "high",
      indice: "Statut propre au transport routier de marchandises (France, depuis le 1er juin 2023) : la plateforme exerce une influence décisive sur les conditions essentielles, le prix ou le choix du transporteur.",
      consequences: [
        "Inscription à un registre électronique national (L. 3263-2 C. transports)",
        "Garanties financières et honorabilité",
        "Vérification continue des transporteurs référencés (L. 3261-2)",
        "Représentant établi en France si l'opérateur est étranger (L. 3263-12)"
      ]
    }
  ];

  /* ---------- Fiches pays ---------- */
  var PAYS = [
    {
      code: "FR", nom: "France", drapeau: "🇫🇷", zone: "Union européenne",
      statut: "Statut à trancher : courtier, commissionnaire ou opérateur de plateforme",
      ton: "high",
      exercice: "Trois régimes coexistent : courtier/mandataire (L. 1411-1 C. transports), commissionnaire de transport (inscription au registre, R. 1422-1) ou opérateur de service numérique de mise en relation (L. 3261-1, 5°) dès que la plateforme pèse sur le prix ou le choix du transporteur.",
      autorite: "Préfet de région (registres) · DGITM / DREAL · Arcom (DSA) · CNIL",
      obligations: [
        "Inscription au registre électronique national si le service est indissociable du transport (L. 3263-2)",
        "Garanties financières et honorabilité professionnelle",
        "Contrôle régulier des transporteurs référencés (L. 3261-2)",
        "Pouvoir produire le document justifiant du prix conclu (L. 3221-3)"
      ],
      numerique: "DSA : Arcom est coordinateur des services numériques depuis la loi SREN (2024). P2B : application à confirmer — le règlement vise les offres faites à des consommateurs.",
      tva: "Lieu de la prestation = établissement du preneur (art. 259-1 CGI). Commission facturée au transporteur : autoliquidation si le transporteur est établi hors de France. E-facturation obligatoire : réception au 1er septembre 2026, émission 2026-2027 selon la taille.",
      vigilance: "La qualification dépend des faits (qui fixe le prix, qui choisit le transporteur, qui porte la responsabilité), pas des CGU.",
      sources: [
        { t: "Code des transports, art. L. 3261-1", u: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000044198543" },
        { t: "Code des transports, art. R. 1422-1 (registre)", u: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000023086525/LEGISCTA000028996751/" },
        { t: "BOFiP — opérations des intermédiaires (TVA)", u: "https://bofip.impots.gouv.fr/bofip/323-PGP.html/identifiant=BOI-TVA-CHAMP-10-10-40-40-20210813" },
        { t: "impots.gouv.fr — facturation électronique", u: "https://www.impots.gouv.fr/professionnel/je-decouvre-la-facturation-electronique" },
        { t: "Arcom — obligations DSA", u: "https://www.arcom.fr/espace-professionnel/reglement-sur-les-services-numeriques-ou-dsa-obligations-et-services-concernes" }
      ]
    },
    {
      code: "DE", nom: "Allemagne", drapeau: "🇩🇪", zone: "Union européenne",
      statut: "Spediteur : commission de transport organisée, sans autorisation propre",
      ton: "medium",
      exercice: "Le Speditionsvertrag (§§ 453 et suivants HGB) oblige à organiser l'expédition (choix du mode, sélection des exécutants) et non à transporter. La licence communautaire n'est exigée que de celui qui exécute du transport routier (§ 3 GüKG).",
      autorite: "Bundesnetzagentur (DSA et P2B) · Handelsregister",
      obligations: [
        "Immatriculation au registre du commerce",
        "Conditions générales sectorielles ADSp 2017 en pratique",
        "Assurance transport / haftung recommandée, non imposée par la loi",
        "Bascule en responsabilité de transporteur si « Spedition zu festen Kosten » (§ 459 HGB)"
      ],
      numerique: "P2B : Bundesnetzagentur compétente depuis 2024 (§ 22 DDG), amendes jusqu'à 300 000 €. DSA : même autorité comme coordinateur des services numériques.",
      tva: "TVA 19 % sur la commission. B2B intra-UE : autoliquidation, mention « Steuerschuldnerschaft des Leistungsempfängers ».",
      vigilance: "La frontière entre organisation et transport détermine le régime : à valider au cas par cas avec un juriste allemand.",
      sources: [
        { t: "§ 453 HGB (contrat de commission de transport)", u: "https://www.gesetze-im-internet.de/hgb/__453.html" },
        { t: "§ 3 GüKG (licence communautaire)", u: "https://www.gesetze-im-internet.de/g_kg_1998/__3.html" },
        { t: "Bundesnetzagentur — P2B", u: "https://www.bundesnetzagentur.de/EN/Areas/Digitalisation/P2B/start.html" },
        { t: "BMF — facturation électronique", u: "https://www.bundesfinanzministerium.de/Content/DE/FAQ/e-rechnung.html" }
      ]
    },
    {
      code: "ES", nom: "Espagne", drapeau: "🇪🇸", zone: "Union européenne",
      statut: "Autorisation d'opérateur de transport obligatoire pour toute intermédiation",
      ton: "high",
      exercice: "La LOTT (loi 16/1987, art. 119.1) soumet à autorisation quiconque intermédie dans la contratation de transports routiers de marchandises : agence de transport, transitario, opérateur logistique « ou tout autre intermédiaire ».",
      autorite: "Ministère des Transports · communautés autonomes · CNMC (DSA)",
      obligations: [
        "Autorisation d'opérateur de transport (OT) et inscription au registre des entreprises",
        "Visado (renouvellement) tous les 2 ans, sous peine de suspension",
        "Capacité financière : 60 000 € (capital + réserves) ou garantie équivalente",
        "Domicile en Espagne pour la mise à disposition des documents"
      ],
      numerique: "P2B : veille assurée par le Secrétariat d'État à la digitalisation (SEDIA). DSA : CNMC désignée coordinateur en 2024.",
      tva: "IVA 21 % sur la commission. B2B intra-UE : autoliquidation (art. 69 LIVA). Facturation électronique B2B : déploiement réglementaire en cours.",
      vigilance: "L'expression « cualquier otro » de l'art. 119.1 rend le risque d'assujettissement élevé pour une plateforme de mise en relation.",
      sources: [
        { t: "LOTT, loi 16/1987 (art. 119)", u: "https://www.boe.es/buscar/act.php?id=BOE-A-1987-17803" },
        { t: "ROTT, RD 1211/1990", u: "https://www.boe.es/eli/es/rd/1990/09/28/1211/con/20251204" },
        { t: "Generalitat — autorisation OT", u: "https://tramits.gencat.cat/es/tramits/tramits-temes/Autoritzacio-doperador-de-transport-OT" },
        { t: "SEDIA — relations plateformes / entreprises", u: "https://digital.gob.es/digitalizacion/servicios/relaciones-plataformas-empresas-p2b" }
      ]
    },
    {
      code: "NL", nom: "Pays-Bas", drapeau: "🇳🇱", zone: "Union européenne",
      statut: "Expediteur : mandat d'expédition, Eurovergunning réservée aux transporteurs",
      ton: "medium",
      exercice: "L'expediteur (Wet wegvervoer goederen, renvoi à l'art. 1090 livre 8 du Code civil) organise le transport. L'Eurovergunning du NIWO ne vise que les entreprises qui transportent effectivement des marchandises pour des tiers.",
      autorite: "NIWO (licences) · ILT (contrôle) · ACM (DSA et P2B)",
      obligations: [
        "Responsabilité en chaîne depuis 2024 : vérifier que le transporteur est régulier (art. 2.14 WWG)",
        "Conservation des documents de transport",
        "Conditions d'expédition néerlandaises en pratique",
        "Taux de TVA 0 % possible pour l'entremise transport dans des cas limitatifs"
      ],
      numerique: "P2B : ACM habilitée depuis novembre 2024. DSA : ACM coordinateur, avec l'autorité de protection des données (AP).",
      tva: "TVA 21 % ; taux 0 % pour la « bemiddeling bij vervoer » dans les cas limitativement énumérés. Commissionnaire agissant en son nom propre : imposition sur le montant total facturé.",
      vigilance: "La responsabilité en chaîne impose une due diligence documentée sur chaque transporteur référencé.",
      sources: [
        { t: "NIWO — Eurovergunning", u: "https://www.niwo.nl/nl/producten/vergunning-wegvervoer/eurovergunning" },
        { t: "NIWO / ILT — responsabilité en chaîne", u: "https://www.niwo.nl/nl/ilt-gaat-ketenaansprakelijkheid-in-het-wegvervoer-controleren" },
        { t: "Belastingdienst — TVA entremise transport", u: "https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/tarieven_en_vrijstellingen/diensten_met_0_btw/bemiddeling_bij_vervoer_en_opslag" }
      ]
    },
    {
      code: "BE", nom: "Belgique", drapeau: "🇧🇪", zone: "Union européenne",
      statut: "Licence de commissionnaire de transport (organisateur de transport)",
      ton: "high",
      exercice: "La loi du 15 juillet 2013 distingue le commissionnaire de transport (fait exécuter en son nom) et le commissionnaire-expéditeur (fait transporter en son nom pour le compte du commettant). La licence d'organisateur de transport, instaurée par l'AR du 18 juillet 1975, est exigée des entreprises établies en Belgique.",
      autorite: "SPF Mobilité et Transports · BIPT (DSA)",
      obligations: [
        "Licence de commissionnaire de transport",
        "Coresponsabilité : vérifier la licence du transporteur à la conclusion du contrat (art. 43)",
        "Conditions générales sectorielles (Forward Belgium)",
        "Facturation électronique structurée obligatoire depuis le 1er janvier 2026"
      ],
      numerique: "DSA : BIPT coordinateur national (loi du 21 avril 2024), avec les régulateurs des Communautés. P2B : autorité de surveillance à confirmer.",
      tva: "TVA 21 % sur la commission ; autoliquidation intra-UE. E-facturation B2B via le réseau Peppol depuis le 1er janvier 2026.",
      vigilance: "Le champ exact de la licence (caution, conditions) doit être vérifié sur les textes consolidés, l'accès automatisé au SPF étant restreint.",
      sources: [
        { t: "Loi du 15 juillet 2013 (art. 5)", u: "https://wallex.wallonie.be/eli/loi-decret/2013/07/15/2013014763/2024/04/06" },
        { t: "SPF Mobilité — licence de commissionnaire", u: "https://mobilit.belgium.be/fr/route/transport/organisateur-de-transport/licence-de-commissionnaire-de-transport" },
        { t: "BIPT — Digital Services Act", u: "https://www.bipt.be/sectors/digital/digital-services-act/digital-service-act" },
        { t: "e-invoice Belgium — obligation B2B 2026", u: "https://einvoice.belgium.be/en/article/when-e-invoicing-mandatory" }
      ]
    },
    {
      code: "IT", nom: "Italie", drapeau: "🇮🇹", zone: "Union européenne",
      statut: "Spedizioniere : déclaration au registre des entreprises (SCIA)",
      ton: "medium",
      exercice: "Le spedizioniere conclut en son nom un contrat de transport pour le compte du mandant (art. 1737 du Code civil). L'albo professionnel a été supprimé en 2012 et remplacé par une déclaration (SCIA) au registre des entreprises, avec la qualification « impresa di spedizione ».",
      autorite: "Camera di Commercio (Registro imprese) · AGCOM (DSA et P2B)",
      obligations: [
        "Déclaration SCIA au registre des entreprises",
        "Capacité financière : 100 000 € de capital libéré ou garanties équivalentes",
        "Caution de 258,23 € auprès de la chambre de commerce",
        "Capacité technico-professionnelle (diplôme ou 2 ans d'expérience)"
      ],
      numerique: "P2B : AGCOM compétente (art. 1, al. 515, loi 178/2020). DSA : AGCOM coordinateur (D.L. 123/2023).",
      tva: "TVA 22 % sur la commission. Facturation électronique obligatoire via le Sistema di Interscambio (SdI) depuis 2019 pour le B2B.",
      vigilance: "Le maintien des conditions de capacité financière après la suppression de l'albo doit être confirmé auprès du registre.",
      sources: [
        { t: "Chambre de commerce — spedizionieri", u: "https://aa.camcom.it/servizi-le-imprese/registri-albi-e-ruoli/albi-e-ruoli/spedizionieri" },
        { t: "AGCOM — P2B", u: "https://www.agcom.it/interventi-dellautorita-su-p2b" },
        { t: "AGCOM — Digital Services Act", u: "https://www.agcom.it/competenze/piattaforme-online/digital-service-act" }
      ]
    },
    {
      code: "GB", nom: "Royaume-Uni", drapeau: "🇬🇧", zone: "Hors Union européenne",
      statut: "Freight forwarder non régulé ; operator licence pour le transport",
      ton: "low",
      exercice: "Aucune licence ni autorité ne régule le métier de freight forwarder ou de broker. La licence d'opérateur routier (operator licence) est en revanche obligatoire pour tout véhicule de plus de 3,5 t utilisé pour le compte d'autrui, et descend à 2,5 t en trafic international.",
      autorite: "Traffic Commissioners (GB) · DfI / TRU (Irlande du Nord) · HMRC (douane)",
      obligations: [
        "Operator licence standard internationale si la plateforme devient « user » d'un véhicule",
        "Établissement au Royaume-Uni pour déclarer en douane",
        "Mandat écrit de représentation douanière (directe ou indirecte)",
        "Conditions commerciales BIFA en pratique"
      ],
      numerique: "DSA non applicable depuis le Brexit ; le Royaume-Uni a son propre régime de services numériques, sans équivalent du P2B.",
      tva: "VAT 20 % sur la commission. E-facturation non obligatoire pour le B2B ; Making Tax Digital pour la déclaration.",
      vigilance: "Une consultation (2026) porte sur un enregistrement obligatoire des intermédiaires douaniers : pas encore en vigueur, à surveiller.",
      sources: [
        { t: "GOV.UK — operator licensing", u: "https://www.gov.uk/guidance/goods-vehicle-operator-licensing-guide" },
        { t: "GOV.UK — dette douanière et représentation", u: "https://www.gov.uk/guidance/customs-debt-liability" },
        { t: "Consultation — enregistrement des intermédiaires douaniers", u: "https://www.gov.uk/government/consultations/introduction-of-mandatory-registration-for-customs-intermediaries" }
      ]
    },
    {
      code: "MA", nom: "Maroc", drapeau: "🇲🇦", zone: "Hors Union européenne",
      statut: "Inscription au registre des commissionnaires obligatoire (nationalité marocaine)",
      ton: "high",
      exercice: "La loi 16-99 définit le commissionnaire comme celui qui organise ou fait exécuter, sous sa responsabilité et en son nom, des opérations de groupage ou d'affrètement. L'inscription au registre spécial est obligatoire et suppose la nationalité marocaine : une société étrangère doit passer par une filiale locale ou un commissionnaire agréé.",
      autorite: "Ministère du Transport et de la Logistique · ADII (douane) · Office des Changes",
      obligations: [
        "Inscription au registre des commissionnaires (décret 2-03-169)",
        "Assurance responsabilité civile souscrite auprès d'assureurs agréés",
        "Manifeste de fret et documents à bord au-delà de 3,5 t",
        "Numéro d'identification Office des Changes pour les paiements internationaux"
      ],
      numerique: "Pas d'équivalent du DSA ni du P2B. Le cadre du commerce électronique reste en construction.",
      tva: "TVA 20 % sur la commission. Retenue à la source possible sur les prestations payées à l'étranger.",
      vigilance: "L'art. 24 bis sanctionne pénalement l'exercice du métier d'intermédiaire sans inscription : 2 000 à 10 000 MAD et 6 jours à 6 mois d'emprisonnement.",
      sources: [
        { t: "Loi 16-99 — transport routier de marchandises", u: "https://maroctl.com/routier/transport-de-marchandises/lois-et-reglements-transport-de-marchandises/loi-n-16-99-relatif-au-transport-routier/" },
        { t: "Décret 2-03-169 (registre des commissionnaires)", u: "https://maroctl.com/routier/transport-de-marchandises/lois-et-reglements-transport-de-marchandises/decret-n-2-03-169-transport-routier-de-marchandises-pour-compte-dautrui-ou-pour-compte-propre/" },
        { t: "Office des Changes — commissionnaires", u: "http://www.oc.gov.ma/fr/personnes-morales/commissionnaires-de-transport-international" },
        { t: "Code des douanes (CDII 2022)", u: "https://www.finances.gov.ma/Publication/adii/2022/cdii2022-fr.pdf" }
      ]
    },
    {
      code: "US", nom: "États-Unis", drapeau: "🇺🇸", zone: "Hors Union européenne",
      statut: "Property broker : autorité FMCSA et caution de 75 000 USD",
      ton: "high",
      exercice: "Est broker celui qui, contre rémunération, organise le transport de marchandises par un transporteur autorisé (49 CFR § 371.2). L'activité exige un enregistrement FMCSA (numéro MC), une garantie financière de 75 000 USD (BMC-84 ou trust fund BMC-85) et un agent processuel (BOC-3) dans chaque État où la société contracte.",
      autorite: "FMCSA (DOT) · CBP (courtage en douane)",
      obligations: [
        "Enregistrement FMCSA et garantie de 75 000 USD maintenue en permanence",
        "Registre de chaque transaction conservé 3 ans (49 CFR § 371.3)",
        "Confirmation écrite transmise au transporteur avant le transport",
        "Licence de customs broker distincte pour les formalités douanières"
      ],
      numerique: "Pas d'équivalent du DSA. Une réforme « Transparency in Property Broker Transactions » est en cours (enregistrement électronique, communication des registres sous 48 h), non finalisée.",
      tva: "Pas de TVA fédérale ; sales tax variable selon l'État. La commission est une prestation de service imposable selon l'État du prestataire.",
      vigilance: "Exercer sans autorisation expose à 10 000 USD par violation, avec responsabilité solidaire des dirigeants (49 U.S.C. § 14916).",
      sources: [
        { t: "49 U.S.C. § 14916 — courtage illégal", u: "https://www.govinfo.gov/content/pkg/USCODE-2024-title49/html/USCODE-2024-title49-subtitleIV-partB-chap149-sec14916.htm" },
        { t: "49 CFR § 371.3 — registres du broker", u: "https://www.govinfo.gov/app/details/CFR-2025-title49-vol5/CFR-2025-title49-vol5-sec371-3" },
        { t: "FMCSA — enregistrement broker", u: "https://www.fmcsa.dot.gov/registration/broker-registration" },
        { t: "CBP — customs brokers", u: "https://www.cbp.gov/trade/programs-administration/customs-brokers/frequently-asked-questions" }
      ]
    },
    {
      code: "CA", nom: "Canada", drapeau: "🇨🇦", zone: "Hors Union européenne",
      statut: "Pas de permis fédéral ; inscription obligatoire au Québec",
      ton: "medium",
      exercice: "Aucune licence fédérale de courtage ou de transit n'existe. Le Québec impose en revanche l'inscription à la liste des intermédiaires en services de transport tenue par la Commission des transports du Québec (CTQ) : tout contrat conclu avec un intermédiaire non inscrit est nul.",
      autorite: "CTQ (Québec) · CBSA (douane) · provinces",
      obligations: [
        "Inscription annuelle à la liste de la CTQ pour le Québec",
        "Contrat de transport conforme (Ontario, O. Reg. 643/05)",
        "Frais de transport détenus en fiducie pour le transporteur (Ontario, HTA 191.0.1)",
        "Licence de courtier en douane et garantie de 50 000 CAD pour le dédouanement"
      ],
      numerique: "Pas d'équivalent du DSA ni du P2B. Adhésion volontaire à la CIFFA comme label commercial.",
      tva: "TPS 5 % + TVQ 9,975 % au Québec sur la commission ; taxe selon la province du preneur.",
      vigilance: "Un courtier canadien organisant du transport intra-américain doit détenir une autorité FMCSA.",
      sources: [
        { t: "CTQ — intermédiaires en services de transport", u: "https://www.ctq.gouv.qc.ca/securite-routiere/intermediaires-en-services-de-transport" },
        { t: "Ontario — O. Reg. 643/05 (contrat de transport)", u: "https://www.ontario.ca/laws/regulation/050643" },
        { t: "CBSA — courtiers en douane", u: "https://www.cbsa-asfc.gc.ca/publications/dm-md/d1/d1-8-1-eng.html" }
      ]
    }
  ];

  /* ---------- Conventions internationales ---------- */
  var CONVENTIONS = [
    {
      mode: "Route",
      nom: "Convention CMR",
      annee: "Genève, 1956",
      portee: "Transport routier international entre deux États dont un est partie (58 États).",
      plafond: "8,33 DTS/kg de poids brut manquant",
      delai: "1 an (3 ans en cas de dol)",
      points: [
        "Lettre de voiture en trois originaux, non négociable",
        "Responsabilité de plein droit entre prise en charge et livraison",
        "Clauses contraires nulles (art. 41)",
        "e-CMR : protocole de 2008, 38 États parties"
      ],
      source: "https://unece.org/DAM/trans/conventn/CMR_prot.pdf"
    },
    {
      mode: "Fer",
      nom: "CIM / COTIF 1999",
      annee: "Vilnius, 1999 (en vigueur 2006)",
      portee: "Transport ferroviaire entre deux États membres de l'OTIF ; lettre CIM/SMGS à l'interface avec le réseau 1520 mm.",
      plafond: "17 DTS/kg",
      delai: "1 an",
      points: [
        "Retard indemnisé jusqu'à 4 fois le prix du transport",
        "Enregistrement électronique admis (art. 6 §9)",
        "Le transporteur peut assumer une responsabilité plus lourde (art. 5)",
        "Lettre de voiture commune CIM/SMGS pour l'Asie"
      ],
      source: "https://otif.org/fileadmin/new/3-Reference-Text/3A-COTIF99/05_Appendix_B.pdf"
    },
    {
      mode: "Air",
      nom: "Convention de Montréal",
      annee: "1999 (en vigueur 2003)",
      portee: "Transport aérien international, environ 140 États parties, UE comprise.",
      plafond: "26 DTS/kg depuis le 28 décembre 2024",
      delai: "2 ans",
      points: [
        "LTA / AWB remplaçable par un enregistrement électronique (e-AWB)",
        "Déclaration de valeur possible par le chargeur",
        "Résolutions IATA 600a et 672 pour l'e-AWB",
        "Distinguer LTA master (compagnie) et house (transitaire)"
      ],
      source: "https://www.icao.int/sites/default/files/inline-files/mtl99_en.pdf"
    },
    {
      mode: "Mer",
      nom: "La Haye-Visby / Hambourg",
      annee: "1924-1968 / 1978",
      portee: "Transport maritime sous connaissement ; Hambourg compte 36 États parties.",
      plafond: "666,67 DTS/colis ou 2 DTS/kg (HV) · 835 DTS ou 2,5 DTS/kg (Hambourg)",
      delai: "1 an (HV) · 2 ans (Hambourg)",
      points: [
        "Le connaissement est un titre négociable : il conditionne la livraison",
        "Rotterdam (2008) n'est pas en vigueur : 5 États sur 20 requis",
        "e-B/L : loi type MLETR ou régime contractuel de place",
        "Énumérer les colis en conteneur pour éviter la limitation forfaitaire"
      ],
      source: "https://unctad.org/topic/transport-and-trade-logistics/policy-and-legislation/international-maritime-transport-law/maritime-conventions"
    },
    {
      mode: "Fluvial",
      nom: "CMNI",
      annee: "Budapest, 2001 (en vigueur 2005)",
      portee: "Navigation intérieure entre deux États dont un est partie (16 États).",
      plafond: "666,67 DTS/colis ou 2 DTS/kg ; conteneur : 1 500 + 25 000 DTS",
      delai: "1 an",
      points: [
        "Document de transport obligatoire, connaissement seulement sur demande",
        "Ne pas appliquer la CMR à un trajet fluvial transfrontalier",
        "Test de l'art. 2 §2 si un connaissement maritime est émis",
        "Signature électronique admise si la loi locale ne l'interdit pas"
      ],
      source: "https://unece.org/fileadmin/DAM/trans/main/sc3/cmniconf/cmni.pdf"
    },
    {
      mode: "Vente",
      nom: "Incoterms® 2020",
      annee: "CCI, applicable au 1er janvier 2020",
      portee: "11 règles répartissant obligations, coûts et transfert des risques entre vendeur et acheteur.",
      plafond: "Aucun : ce n'est pas un plafond de responsabilité",
      delai: "—",
      points: [
        "Ne règle ni la propriété, ni le droit applicable, ni les litiges",
        "Toujours indiquer la règle, le lieu nommé et le millésime",
        "FCA recommandé plutôt qu'EXW à l'export",
        "FOB/CFR/CIF inadaptés au conteneur : préférer FCA/CPT/CIP"
      ],
      source: "https://iccwbo.org/business-solutions/incoterms-rules/incoterms-2020/"
    }
  ];

  /* ---------- Obligations transverses de la plateforme ---------- */
  var OBLIGATIONS = [
    {
      titre: "DSA — services numériques",
      texte: "Une plateforme qui héberge et diffuse des offres est un service d'hébergement, et une plateforme en ligne si les offres sont publiques. À ce titre : point de contact, conditions générales claires, mécanisme de signalement, motivation des restrictions, transparence du classement. En France, l'Arcom est coordinateur depuis 2024.",
      source: "https://eur-lex.europa.eu/eli/reg/2022/2065/oj?locale=fr"
    },
    {
      titre: "P2B — relations plateformes / entreprises",
      texte: "Préavis de 15 jours avant modification des conditions, motifs de suspension énoncés à l'avance, transparence des paramètres de classement. Le champ suppose des offres destinées à des consommateurs : une place de marché 100 % B2B peut en sortir, mais l'application volontaire est recommandée.",
      source: "https://eur-lex.europa.eu/eli/reg/2019/1150/oj?locale=fr"
    },
    {
      titre: "RGPD — données personnelles",
      texte: "Responsable de traitement pour les comptes, la vérification des transporteurs et la sécurité ; sous-traitant pour les traitements réalisés pour un client. Registre, base légale, information, sécurité, et AIPD si un profilage ou une notation est mis en place.",
      source: "https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=fr"
    },
    {
      titre: "Preuve électronique — eIDAS",
      texte: "L'effet juridique d'une signature électronique ne peut être refusé au seul motif qu'elle est électronique ; la signature qualifiée équivaut à une signature manuscrite. Pour les acceptations d'offres : horodatage, journal inaltérable et archivage de la version acceptée.",
      source: "https://eur-lex.europa.eu/eli/reg/2014/910/oj?locale=fr"
    },
    {
      titre: "TVA et facturation électronique",
      texte: "Commission B2B : lieu du preneur (art. 44 de la directive 2006/112/CE), autoliquidation si le prestataire n'est pas établi dans le pays du client. Facturation électronique : Italie depuis 2019, Belgique depuis 2026, France 2026-2027, Allemagne 2027-2028.",
      source: "https://taxation-customs.ec.europa.eu/taxation/vat/vat-directive/place-taxation_en"
    },
    {
      titre: "Règlement des litiges",
      texte: "La convention de La Haye de 2019 sur les jugements exclut expressément le transport : l'arbitrage (règlement CCI 2021, convention de New York) reste le mécanisme fiable de reconnaissance transfrontalière. Prévoir médiation puis arbitrage, avec siège et langue.",
      source: "https://iccwbo.org/dispute-resolution/dispute-resolution-services/arbitration/rules-procedure/2021-arbitration-rules/"
    }
  ];

  /* ---------- Points à faire trancher avant lancement ---------- */
  var CHECKLIST = [
    "Trancher la qualification : qui fixe le prix, qui choisit le transporteur, qui porte la responsabilité de la bonne fin ?",
    "Vérifier si le modèle tombe sous l'art. L. 3261-1, 5° du Code des transports (registre, garanties, représentant en France).",
    "Faire confirmer le régime de TVA de la commission, y compris l'identité du preneur lorsque le transporteur paie.",
    "Faire valider l'application du P2B à une place de marché exclusivement B2B.",
    "Documenter la vérification des transporteurs (licences, registres, assurances) avec dates d'expiration.",
    "Choisir une plateforme agréée d'e-facturation avant l'échéance applicable.",
    "Rédiger la clause de non-contournement de façon proportionnée (durée, périmètre, preuve).",
    "Sécuriser la preuve d'acceptation : versionnage des CGU, empreinte, horodatage, journal d'audit."
  ];

  window.LEGAL_DATA = {
    miseAJour: MISE_A_JOUR,
    qualifications: QUALIFICATIONS,
    pays: PAYS,
    conventions: CONVENTIONS,
    obligations: OBLIGATIONS,
    checklist: CHECKLIST
  };
})();
