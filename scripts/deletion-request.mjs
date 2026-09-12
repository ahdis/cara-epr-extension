// Deletion request on ONE superseded community-X document, mirroring the portal's updateMetadata() exactly.
import { randomUUID } from 'node:crypto';
const TOKEN_URL='https://api-portals.cara.ch/tenant/realm-pat-swissid/openid-connect/token', FHIR='https://api-portals.cara.ch/ad-adaptor/api/r4';
const claims=t=>JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'),'base64').toString());
const post=async p=>{const r=await fetch(TOKEN_URL,{method:'POST',body:new URLSearchParams(p)});if(!r.ok)throw new Error(r.status+' '+(await r.text()).slice(0,100));return r.json();};
const idp=await post({grant_type:'refresh_token',client_id:'emedo-pr-web',redirect_uri:'https://patient.cara.ch/login',refresh_token:process.env.EPR_REFRESH_TOKEN});
const xua=await post({client_id:'emedo-pr-web',grant_type:'urn:ietf:params:oauth:grant-type:token-exchange',subject_token:idp.access_token,subject_token_type:'urn:ietf:params:oauth:token-type:access_token',home_community_id:'urn:oid:2.16.756.5.30.1.177',purpose_of_use:'NORM',role:'PAT',resource_id:claims(idp.id_token).spid});
const H={authorization:'Bearer '+xua.access_token};
const dec=id=>Buffer.from(id,'base64').toString();
const delStatus=d=>d.extension?.find(x=>x.url.endsWith('ch-ext-deletionstatus'))?.valueCoding?.code ?? (d.extension?.find(x=>x.url.endsWith('/extraMetadata'))?.extension?.find(x=>x.url==='urn:e-health-suisse:2019:deletionStatus')?.valueString ?? '-');

// 1. find the target by --title <substring> --hc X|CARA [--status current|superseded]; default = oldest superseded FluarixTextra in X
const arg=(k,d)=>process.argv.includes(k)?process.argv[process.argv.indexOf(k)+1]:d;
const HCS={X:'urn:oid:2.16.756.5.30.1.194.3.0',CARA:'urn:oid:2.16.756.5.30.1.177'};
const title=arg('--title','FluarixTextra'), hcWant=HCS[arg('--hc','X')], statusWant=arg('--status','superseded');
const b=await (await fetch(`${FHIR}/DocumentReference?status=current,superseded&_revinclude=List:item`,{headers:H})).json();
const docs=b.entry.map(e=>e.resource).filter(r=>r.resourceType==='DocumentReference');
const cands=docs.filter(d=>(statusWant==='any'||d.status===statusWant)&&d.content[0].attachment.title.includes(title)&&dec(d.id).endsWith('@'+hcWant))
  .sort((a,b)=>(a.content[0].attachment.creation??'').localeCompare(b.content[0].attachment.creation??'')||a.masterIdentifier.value.localeCompare(b.masterIdentifier.value));
console.log(`candidates for title~"${title}" hc=${hcWant} status=${statusWant}: ${cands.length}; deletion status before: ${[...new Set(cands.map(delStatus))].join(',')||'-'}`);
if(cands.length!==1&&!process.argv.includes('--first')){console.log('refusing: need exactly one candidate (or pass --first). Candidates:',cands.map(d=>`${d.content[0].attachment.title} ${d.status} ${d.content[0].attachment.creation}`));process.exit(cands.length?2:1);}
const t=cands[0];
console.log('target:',dec(t.id),'| title',t.content[0].attachment.title,'| masterIdentifier',t.masterIdentifier.value,'| creation',t.content[0].attachment.creation,'| status',t.status);
if (process.argv.includes('--dry-run')) process.exit(0);

// 2. build the update bundle like documents.js updateMetadata()
const uuidToOid=u=>'urn:oid:2.25.'+BigInt('0x'+u.replaceAll('-','')).toString();
const listId=randomUUID();
const list={resourceType:'List',id:listId,extension:[{url:'http://profiles.ihe.net/ITI/MHD/StructureDefinition/ihe-designationType',valueCodeableConcept:{coding:[{code:'71388002',system:'2.16.840.1.113883.6.96',display:'Procedure (procedure)'}]}}],
  code:{coding:[{system:'http://profiles.ihe.net/ITI/MHD/CodeSystem/MHDlistTypes',code:'submissionset'}]},
  identifier:[{value:uuidToOid(randomUUID()),system:'urn:ietf:rfc:3986'},{value:'urn:uuid:'+randomUUID(),system:'urn:ietf:rfc:3986'}],
  status:'current',date:new Date().toISOString().replace(/\.\d{3}Z$/,'+00:00'),source:{reference:'#1'},
  contained:[{id:'1',resourceType:'PractitionerRole',code:[{coding:[{code:'PAT',system:'2.16.756.5.30.1.127.3.10.6'}]}]}],
  entry:[{item:{reference:t.id}}]};
const dr={resourceType:'DocumentReference',id:t.id,extension:[{url:'http://fhir.ch/ig/ch-epr-mhealth/StructureDefinition/ch-ext-deletionstatus',valueCoding:{system:'http://fhir.ch/ig/ch-epr-mhealth/CodeSystem/ch-ehealth-codesystem-deletionstatus',code:'deletionRequested'}}],content:[]};
const bundle={resourceType:'Bundle',meta:{profile:['https://api.phellowseven.com/fhir/StructureDefinition/IHE.MHD.Metadata.Update']},type:'transaction',entry:[
  {fullUrl:'List/'+listId,resource:list,request:{method:'POST',url:'List/'+listId}},
  {fullUrl:'DocumentReference/'+t.id,resource:dr,request:{method:'PUT',url:'DocumentReference/'+t.id}}]};
const r=await fetch(`${FHIR}/`,{method:'POST',headers:{...H,'content-type':'application/json'},body:JSON.stringify(bundle)});
const txt=await r.text();
console.log('update response:',r.status,r.headers.get('content-type'));
console.log(txt.slice(0,2500));

// 3. re-read
await new Promise(r=>setTimeout(r,2000));
const r2=await fetch(`${FHIR}/DocumentReference/${t.id}`,{headers:H});
const after=r2.status===200?await r2.json():null;
console.log('re-read:',r2.status,'| status',after?.status,'| deletion status after:',after?delStatus(after):'n/a');
if(after) console.log(JSON.stringify(after.extension,null,1).slice(0,1500));
