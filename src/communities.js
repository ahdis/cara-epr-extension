// Swiss EPR community OIDs → display names. Source: https://oid.refdata.ch/tree/2.16.756.5.30.1 (read 2026-09-12).
// Keys are root nodes; a document's homeCommunityId is matched by longest prefix (e.g. 2.16.756.5.30.1.194.3.0 → Sanela).
// Static on purpose: the extension must not load remote data.
export const COMMUNITIES = Object.freeze({
  '2.16.756.5.30.1.177': { name: 'emedo (eHealth Aargau)', description: 'Root Node der Stammgemeinschaft eHealth Aargau (SteHAG), registered name "stehag"; technical home community of the CARA portal' },
  '2.16.756.5.30.1.191': { name: 'CARA', description: 'Community according to EPRA supported by cantons of Geneva, Valais, Vaud, Fribourg and Jura' },
  '2.16.756.5.30.1.192': { name: 'Abilis', description: 'ABILIS Nationale interprofessionelle Stammgemeinschaft der Medikation AG' },
  '2.16.756.5.30.1.193': { name: 'Jura', description: 'registered name "jura"' },
  '2.16.756.5.30.1.194': { name: 'Sanela', description: 'Root Node Sanela-Stammgemeinschaft' },
  '2.16.756.5.30.1.195': { name: 'Sanela B2B', description: 'registered name "Sanela B2B"' },
  '2.16.756.5.30.1.196': { name: 'CHUV', description: 'registered name "chuv"' },
  '2.16.756.5.30.1.190': { name: 'Post E-Health', description: 'Root OID Post E-Health Plattform' },
  '2.16.756.5.30.1.198': { name: 'Hirslanden', description: 'EPD Root OID für die Hirslanden AG Gruppe' },
  '2.16.756.5.30.1.109': { name: 'Swisscom Health', description: 'Hauptknoten der Unternehmensdomain Swisscom Health AG' },
  '2.16.756.5.30.1.214': { name: 'Communauté de référence Neuchâtel', description: 'Association Communauté de référence au sens de la LDEP portée par les prestataires de santé de Neuchâtel' },
});

/** @returns {{oid:string, name:string|null, description:string|null}} */
export function communityInfo(homeCommunityId) {
  const oid = String(homeCommunityId ?? '').replace(/^urn:oid:/, '');
  let best = null;
  for (const key of Object.keys(COMMUNITIES)) {
    if ((oid === key || oid.startsWith(key + '.')) && (!best || key.length > best.length)) best = key;
  }
  return { oid, name: best ? COMMUNITIES[best].name : null, description: best ? COMMUNITIES[best].description : null };
}

/** "Sanela (2.16.756.5.30.1.194.3.0)" or just the OID when unknown */
export function communityLabel(homeCommunityId) {
  const { oid, name } = communityInfo(homeCommunityId);
  return name ? `${name} (${oid})` : oid;
}
