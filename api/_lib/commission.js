"use strict";

/* Le barème de commission vit dans assets/js/commission.js : une seule
   implémentation, partagée par le navigateur et par les fonctions
   serverless. Ce fichier n'existe que pour garder le chemin d'import
   ./_lib/commission côté API. */
module.exports = require("../../assets/js/commission.js");
