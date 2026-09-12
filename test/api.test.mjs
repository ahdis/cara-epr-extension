import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  decodeDocumentId, homeCommunityOf, repositoryOf, deletionStatusOf, attachmentOf, splitBundle, classify, caraHashSet,
  buildProvideBundle, buildDeletionBundle, sha1Base64, uuidToDecimal, isoWithOffset, findCopy, tenantForIdp, authorDisplayOf,
  decodeJwt, EXT, PROFILES, uniqueIdOf, sourceAuthor, checkCompatibility,
} from '../src/api.js';
import { communityInfo, communityLabel } from '../src/communities.js';

const CARA = 'urn:oid:2.16.756.5.30.1.177';
const X = 'urn:oid:2.16.756.5.30.1.194.3.0';
const bundle = JSON.parse(readFileSync(new URL('../DocumentReferenceOE.json', import.meta.url)));
const { docs, lists } = splitBundle(bundle);

const seq = () => { let i = 0; return () => `00000000-0000-4000-8000-${String(++i).padStart(12, '0')}`; };

test('sample bundle splits into 22 DocumentReferences and 3 Lists', () => {
  assert.equal(docs.length, 22);
  assert.equal(lists.length, 3);
});

test('id decoding and community accessors', () => {
  const d = docs[0];
  const { entryUuid, homeCommunityId } = decodeDocumentId(d.id);
  assert.equal(entryUuid, '297e1ab2-5c71-4fd3-97db-1e05a1bd1c97');
  assert.equal(homeCommunityId, X);
  assert.equal(homeCommunityOf(d), X);
  assert.equal(repositoryOf(d), '2.16.756.5.30.1.194.3.0.12.1.101.31');
  assert.equal(uniqueIdOf(d), '2.16.756.5.30.1.194.3.0.12.3.101^8373598a-33bf-4383-97e4-98d7fb5c8d95');
  assert.equal(authorDisplayOf(d), 'Anna Muster');
});

test('deletion status: CARA-native carries ch-ext-deletionstatus, foreign docs may carry none', () => {
  const cara = docs.find(d => homeCommunityOf(d) === CARA);
  const status = deletionStatusOf(cara);
  assert.ok(status === 'deletionNotRequested' || status === null);
  assert.equal(deletionStatusOf(docs[0]), null);
});

test('classification of the sample account', () => {
  const caraHashes = caraHashSet(docs, CARA);
  assert.equal(caraHashes.size, 3);
  const counts = {};
  for (const d of docs) {
    const s = classify(d, { caraHashes, homeCommunityId: CARA });
    counts[s] = (counts[s] ?? 0) + 1;
  }
  // 4 current PDFs + 4 current FHIR JSON transferable, 11 superseded, 3 native
  assert.deepEqual(counts, { transferable: 8, superseded: 11, native: 3 });
  const odd = { ...docs[0], content: [{ attachment: { ...attachmentOf(docs[0]), contentType: 'image/jpeg', hash: 'zz' } }] };
  assert.equal(classify(odd, { caraHashes, homeCommunityId: CARA }), 'unsupported');
});

test('copy exists wins over everything else', () => {
  const d = docs[0];
  const s = classify(d, { caraHashes: new Set([attachmentOf(d).hash]), homeCommunityId: CARA });
  assert.equal(s, 'copyExists');
  const sup = docs.find(x => x.status === 'superseded');
  assert.equal(classify(sup, { caraHashes: new Set([attachmentOf(sup).hash]), homeCommunityId: CARA }), 'copyExists');
});

test('sha1Base64 matches node crypto', async () => {
  const bytes = new TextEncoder().encode('hello cara');
  const expected = createHash('sha1').update(bytes).digest('base64');
  assert.equal(await sha1Base64(bytes), expected);
});

test('uuid → decimal OID and ISO offset format', () => {
  assert.equal(uuidToDecimal('00000000-0000-0000-0000-000000000001'), '1');
  assert.equal(uuidToDecimal('ffffffff-ffff-ffff-ffff-ffffffffffff'), '340282366920938463463374607431768211455');
  assert.match(isoWithOffset(new Date('2026-09-12T10:00:00Z')), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test('buildProvideBundle matches the captured ITI-65 shape (spec 3.3)', () => {
  const source = docs.find(d => attachmentOf(d).title === 'Covid_vaccination_certificate');
  const hash = attachmentOf(source).hash;
  const { bundle: b, docUrn, docPart, listId, masterIdentifier } = buildProvideBundle({
    source, size: 145525, hash, author: { given: 'Anna', family: 'Muster' }, newUuid: seq(), date: '2026-09-12T12:00:00+02:00', keepAuthor: false,
  });
  assert.equal(b.resourceType, 'Bundle');
  assert.equal(b.type, 'transaction');
  assert.deepEqual(b.meta.profile, [PROFILES.provideBundle]);
  assert.equal(b.entry.length, 2);
  assert.ok(b.entry.every(e => !('request' in e)), 'no request elements');
  assert.ok(!b.entry.some(e => e.resource.resourceType === 'Binary'), 'no Binary resource');

  const [listEntry, docEntry] = b.entry;
  assert.equal(listEntry.fullUrl, listId);
  assert.equal(listEntry.resource.resourceType, 'List');
  assert.equal(listEntry.resource.id, listId);
  assert.deepEqual(listEntry.resource.contained, [{ resourceType: 'PractitionerRole', id: '1', code: [{ coding: [{ system: '2.16.756.5.30.1.127.3.10.6', code: 'PAT' }] }] }]);
  assert.equal(listEntry.resource.extension[0].url, EXT.designationType);
  assert.equal(listEntry.resource.extension[0].valueCodeableConcept.coding[0].code, '71388002');
  assert.match(listEntry.resource.identifier[0].value, /^urn:oid:2\.25\.\d+$/);
  assert.match(listEntry.resource.identifier[1].value, /^urn:uuid:/);
  assert.equal(listEntry.resource.status, 'current');
  assert.equal(listEntry.resource.code.coding[0].code, 'submissionset');
  assert.equal(listEntry.resource.date, '2026-09-12T12:00:00+02:00');
  assert.deepEqual(listEntry.resource.source, { reference: '#1' });
  assert.deepEqual(listEntry.resource.entry, [{ item: { reference: docUrn } }]);
  assert.ok(!('subject' in listEntry.resource));

  const dr = docEntry.resource;
  assert.equal(docEntry.fullUrl, docUrn);
  assert.equal(dr.id, docUrn);
  assert.match(docUrn, /^urn:uuid:/);
  assert.match(docPart, /^urn:uuid:/);
  assert.notEqual(docUrn, docPart);
  assert.deepEqual(dr.contained, [
    { resourceType: 'Practitioner', id: '2', name: [{ family: 'Muster', given: ['Anna'] }] },
    { resourceType: 'PractitionerRole', id: '1', practitioner: { reference: '#2' } },
  ]);
  assert.deepEqual(dr.masterIdentifier, { system: 'urn:ietf:rfc:3986', value: masterIdentifier });
  assert.match(masterIdentifier, /^2\.25\.\d+$/);
  assert.deepEqual(dr.identifier, [{ system: 'urn:ietf:rfc:3986', value: docUrn }]);
  assert.equal(dr.status, 'current');
  assert.deepEqual(dr.type, source.type);
  assert.deepEqual(dr.category, source.category);
  assert.deepEqual(dr.securityLabel, source.securityLabel);
  assert.deepEqual(dr.author, [{ reference: '#1' }]);
  assert.deepEqual(dr.content, [{
    attachment: {
      contentType: 'application/pdf', language: attachmentOf(source).language, url: docPart, size: 145525, hash,
      title: 'Covid_vaccination_certificate', creation: attachmentOf(source).creation,
    },
    format: source.content[0].format,
  }]);
  assert.deepEqual(dr.context, { facilityType: source.context.facilityType, practiceSetting: source.context.practiceSetting });
  for (const forbidden of ['subject', 'extension', 'meta', 'relatesTo', 'date']) assert.ok(!(forbidden in dr), `${forbidden} must not be sent`);
  assert.ok(!('sourcePatientInfo' in dr.context));
  assert.ok(!('period' in dr.context));
});

test('buildDeletionBundle matches the executed metadata update (spec 3.4)', () => {
  const target = docs.find(d => d.status === 'superseded');
  const { bundle: b, listId } = buildDeletionBundle({ sourceId: target.id, newUuid: seq(), date: '2026-09-12T12:00:00+02:00' });
  assert.deepEqual(b.meta.profile, [PROFILES.metadataUpdate]);
  assert.equal(b.type, 'transaction');
  assert.equal(b.entry.length, 2);
  const [l, d] = b.entry;
  assert.equal(l.fullUrl, 'List/' + listId);
  assert.deepEqual(l.request, { method: 'POST', url: 'List/' + listId });
  assert.deepEqual(l.resource.entry, [{ item: { reference: target.id } }]);
  assert.equal(d.fullUrl, 'DocumentReference/' + target.id);
  assert.deepEqual(d.request, { method: 'PUT', url: 'DocumentReference/' + target.id });
  assert.deepEqual(d.resource, {
    resourceType: 'DocumentReference',
    id: target.id,
    extension: [{ url: EXT.deletionStatus, valueCoding: { system: 'http://fhir.ch/ig/ch-epr-mhealth/CodeSystem/ch-ehealth-codesystem-deletionstatus', code: 'deletionRequested' } }],
    content: [],
  });
  assert.throws(() => buildDeletionBundle({ sourceId: '' }));
});

test('findCopy finds the CARA document by hash and prefers the exact docUrn', () => {
  const cara = docs.filter(d => homeCommunityOf(d) === CARA);
  const target = cara[1];
  const found = findCopy(docs, { hash: attachmentOf(target).hash, homeCommunityId: CARA });
  assert.equal(found.id, target.id);
  assert.equal(findCopy(docs, { hash: attachmentOf(docs[0]).hash, homeCommunityId: CARA }), null);
  const withUrn = findCopy(docs, { hash: attachmentOf(target).hash, homeCommunityId: CARA, docUrn: target.identifier[0].value });
  assert.equal(withUrn.id, target.id);
});

test('tenant derivation and jwt decode', () => {
  assert.equal(tenantForIdp('SwissID'), 'realm-pat-swissid');
  assert.equal(tenantForIdp('TrustID'), 'realm-pat-trustid');
  assert.equal(tenantForIdp(null), 'realm-pat-swissid');
  const payload = Buffer.from(JSON.stringify({ spid: '761337610000000000', given_name: 'A', family_name: 'B' })).toString('base64url');
  assert.deepEqual(decodeJwt(`eyJhbGciOiJIUzI1NiJ9.${payload}.sig`), { spid: '761337610000000000', given_name: 'A', family_name: 'B' });
  assert.equal(decodeJwt('garbage'), null);
});

test('the source author metadata is copied by default; keepAuthor=false or no resolvable author → patient', () => {
  const source = docs.find(d => attachmentOf(d).title === '20221015_AustrittsberichtTriemli');
  const sa = sourceAuthor(source);
  assert.ok(sa.contained.some(c => c.resourceType === 'PractitionerRole'));
  assert.ok(sa.contained.some(c => c.resourceType === 'Practitioner'));
  assert.ok(sa.contained.some(c => c.resourceType === 'Organization'));
  assert.ok(!sa.contained.some(c => c.resourceType === 'Patient'), 'sourcePatientInfo must not be copied');
  assert.deepEqual(sa.author, source.author);
  const kept = buildProvideBundle({ source, size: 1, hash: 'x', author: { given: 'A', family: 'B' }, newUuid: seq() }); // default keeps the author
  assert.equal(kept.authorKept, true);
  const dr = kept.bundle.entry[1].resource;
  assert.deepEqual(dr.author, source.author);
  assert.deepEqual(dr.contained, sa.contained);
  assert.equal(authorDisplayOf(dr), authorDisplayOf(source));
  const plain = buildProvideBundle({ source, size: 1, hash: 'x', author: { given: 'A', family: 'B' }, newUuid: seq(), keepAuthor: false });
  assert.equal(plain.authorKept, false);
  assert.deepEqual(plain.bundle.entry[1].resource.author, [{ reference: '#1' }]);
  assert.equal(authorDisplayOf(plain.bundle.entry[1].resource), 'A B');
  // a source without a resolvable author falls back to the patient even with keepAuthor
  const noAuthor = { ...source, author: [{ reference: 'Practitioner/123' }] };
  assert.equal(buildProvideBundle({ source: noAuthor, size: 1, hash: 'x', author: { given: 'A', family: 'B' }, newUuid: seq(), keepAuthor: true }).authorKept, false);
});

test('community names by OID prefix', () => {
  assert.deepEqual(communityInfo('urn:oid:2.16.756.5.30.1.194.3.0').name, 'Sanela');
  assert.equal(communityLabel('urn:oid:2.16.756.5.30.1.194.3.0'), 'Sanela (2.16.756.5.30.1.194.3.0)');
  assert.equal(communityInfo('2.16.756.5.30.1.191').name, 'CARA');
  assert.equal(communityInfo('urn:oid:2.16.756.5.30.1.1940').name, null);
  assert.equal(communityLabel('urn:oid:1.2.3'), '1.2.3');
});

test('compatibility self-check accepts the verified shape and flags deviations', () => {
  const fhir = 'https://api-portals.cara.ch/ad-adaptor/api/r4';
  assert.deepEqual(checkCompatibility(bundle, { fhir }), { ok: true, problems: [] });
  assert.deepEqual(checkCompatibility({ resourceType: 'OperationOutcome' }, { fhir }), { ok: false, problems: ['notBundle'] });
  assert.deepEqual(checkCompatibility({ resourceType: 'Bundle', type: 'searchset', entry: [] }, { fhir }), { ok: true, problems: [] });
  const clone = JSON.parse(JSON.stringify(bundle));
  const first = clone.entry.find(e => e.resource.resourceType === 'DocumentReference').resource;
  first.extension = first.extension.filter(x => !x.url.endsWith('/homeCommunityId'));
  first.content[0].attachment.url = 'https://elsewhere.example/Binary/x';
  delete first.content[0].attachment.hash;
  const r = checkCompatibility(clone, { fhir });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems.sort(), ['noBinaryUrl', 'noHash', 'noHomeCommunityExtension']);
});
