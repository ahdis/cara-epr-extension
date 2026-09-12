const TOKEN_URL='https://api-portals.cara.ch/tenant/realm-pat-swissid/openid-connect/token', FHIR='https://api-portals.cara.ch/ad-adaptor/api/r4';
const claims=t=>JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'),'base64').toString());
const post=async p=>{const r=await fetch(TOKEN_URL,{method:'POST',body:new URLSearchParams(p)});if(!r.ok)throw new Error(r.status+' '+(await r.text()).slice(0,100));return r.json();};
const idp=await post({grant_type:'refresh_token',client_id:'emedo-pr-web',redirect_uri:'https://patient.cara.ch/login',refresh_token:process.env.EPR_REFRESH_TOKEN});
const xua=await post({client_id:'emedo-pr-web',grant_type:'urn:ietf:params:oauth:grant-type:token-exchange',subject_token:idp.access_token,subject_token_type:'urn:ietf:params:oauth:token-type:access_token',home_community_id:'urn:oid:2.16.756.5.30.1.177',purpose_of_use:'NORM',role:'PAT',resource_id:claims(idp.id_token).spid});
const H={authorization:'Bearer '+xua.access_token};
const dec=id=>Buffer.from(id,'base64').toString();
const TARGET='NWE3MzFiM2UtYmYxMC00NWE0LWE5MTMtMzg1NWE3OTI3Y2M2QHVybjpvaWQ6Mi4xNi43NTYuNS4zMC4xLjE5NC4zLjA=';
const delStatus=d=>d.extension?.find(x=>x.url.endsWith('ch-ext-deletionstatus'))?.valueCoding?.code ?? (d.extension?.find(x=>x.url.endsWith('/extraMetadata'))?.extension?.find(x=>x.url==='urn:e-health-suisse:2019:deletionStatus')?.valueString ?? '-');
const b=await (await fetch(`${FHIR}/DocumentReference?status=current,superseded&_revinclude=List:item`,{headers:H})).json();
const docs=b.entry.map(e=>e.resource).filter(r=>r.resourceType==='DocumentReference');
console.log('total DocumentReference now:',docs.length,'(was 22); Lists:',b.entry.length-docs.length,'(was 3)');
const fl=docs.filter(d=>d.content[0].attachment.title.includes('FluarixTextra'));
console.log('FluarixTextra entries now:',fl.length,'(was 10); deletion statuses:',fl.map(delStatus).join(','));
const t=docs.find(d=>d.id===TARGET);
console.log('target still in search result:',!!t, t?`| status ${t.status} | deletion ${delStatus(t)} | versionId ${t.meta?.versionId}`:'');
if(t) console.log(JSON.stringify(t.extension,null,0).slice(0,1200));
// baseline: read-by-id for an untouched X doc and a CARA doc
const otherX=docs.find(d=>d.id!==TARGET&&dec(d.id).endsWith('@urn:oid:2.16.756.5.30.1.194.3.0'));
const cara=docs.find(d=>dec(d.id).endsWith('@urn:oid:2.16.756.5.30.1.177'));
for (const [label,d] of [['untouched X doc',otherX],['CARA doc',cara]]) { const r=await fetch(`${FHIR}/DocumentReference/${d.id}`,{headers:H}); console.log(`GET by id (${label}):`,r.status); }
const r=await fetch(`${FHIR}/DocumentReference/${TARGET}`,{headers:H}); console.log('GET by id (target):',r.status,(await r.text()).slice(0,300));
// new submission set visible?
const lists=b.entry.map(e=>e.resource).filter(r=>r.resourceType==='List');
console.log('Lists referencing target:',lists.filter(l=>l.entry?.some(e=>e.item.reference.endsWith(TARGET))).map(l=>l.id.slice(0,16)+'… date '+l.date));
