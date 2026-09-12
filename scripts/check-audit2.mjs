const TOKEN_URL='https://api-portals.cara.ch/tenant/realm-pat-swissid/openid-connect/token', FHIR='https://api-portals.cara.ch/ad-adaptor/api/r4';
const claims=t=>JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'),'base64').toString());
const post=async p=>{const r=await fetch(TOKEN_URL,{method:'POST',body:new URLSearchParams(p)});if(!r.ok)throw new Error(r.status+' '+(await r.text()).slice(0,100));return r.json();};
const idp=await post({grant_type:'refresh_token',client_id:'emedo-pr-web',redirect_uri:'https://patient.cara.ch/login',refresh_token:process.env.EPR_REFRESH_TOKEN});
const xua=await post({client_id:'emedo-pr-web',grant_type:'urn:ietf:params:oauth:grant-type:token-exchange',subject_token:idp.access_token,subject_token_type:'urn:ietf:params:oauth:token-type:access_token',home_community_id:'urn:oid:2.16.756.5.30.1.177',purpose_of_use:'NORM',role:'PAT',resource_id:claims(idp.id_token).spid});
const H={authorization:'Bearer '+xua.access_token,accept:'application/fhir+json'};
const b=await (await fetch(`${FHIR}/AuditEvent?date=ge2026-09-12`,{headers:H})).json();
const evs=(b.entry||[]).map(e=>e.resource).filter(r=>r.resourceType==='AuditEvent');
const others=(b.entry||[]).map(e=>e.resource).filter(r=>r.resourceType!=='AuditEvent'); if(others.length) console.log('non-AuditEvent entries:',others.map(r=>r.resourceType));
const subs=new Map(); for(const a of evs){const k=(a.type?.code||'')+' '+(a.subtype||[]).map(s=>s.code).join('/');subs.set(k,(subs.get(k)||0)+1);} console.log('event kinds today:',[...subs]);
const fmt=a=>`${a.recorded} | ${a.type?.code} ${(a.subtype||[]).map(s=>s.code+(s.display?'('+s.display+')':'')).join('/')} | action ${a.action} | outcome ${a.outcome} ${a.outcomeDesc||''} | agents: ${(a.agent||[]).map(g=>[g.type?.coding?.[0]?.code,g.who?.display,g.who?.identifier?.value,g.role?.map(r=>r.coding?.[0]?.code).join('+'),g.requestor?'requestor':''].filter(Boolean).join('/')).join(' ; ')} | source ${a.source?.observer?.display||a.source?.observer?.identifier?.value||''}`;
console.log('\n=== most recent 12 events');
for (const a of evs.slice(0,12)) console.log(' ',fmt(a));
console.log('\n=== events that are not SEARCH/READ, full detail');
for (const a of evs.filter(a=>!/SEARCH|READ|LOG_READ/.test((a.subtype||[]).map(s=>s.code).join()))) { console.log(fmt(a)); console.log(JSON.stringify(a.entity,null,0).slice(0,1500)); console.log(); }
console.log('\n=== events mentioning the target entryUUID');
for (const a of evs.filter(a=>JSON.stringify(a).includes('5a731b3e-bf10-45a4-a913-3855a7927cc6'))) { console.log(fmt(a)); console.log(JSON.stringify(a.entity,null,0).slice(0,1200)); }
