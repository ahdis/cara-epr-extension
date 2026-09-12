// Copy ONE community-X document into CARA, mirroring the portal's ITI-65 multipart upload (captured 2026-09-12).
import { randomUUID, createHash } from 'node:crypto';
const TOKEN_URL='https://api-portals.cara.ch/tenant/realm-pat-swissid/openid-connect/token', FHIR='https://api-portals.cara.ch/ad-adaptor/api/r4';
const X='urn:oid:2.16.756.5.30.1.194.3.0', CARA='urn:oid:2.16.756.5.30.1.177';
const claims=t=>JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'),'base64').toString());
const post=async p=>{const r=await fetch(TOKEN_URL,{method:'POST',body:new URLSearchParams(p)});if(!r.ok)throw new Error(r.status+' '+(await r.text()).slice(0,100));return r.json();};
const idp=await post({grant_type:'refresh_token',client_id:'emedo-pr-web',redirect_uri:'https://patient.cara.ch/login',refresh_token:process.env.EPR_REFRESH_TOKEN});
const spid=claims(idp.id_token).spid, name=claims(idp.id_token);
const xua=await post({client_id:'emedo-pr-web',grant_type:'urn:ietf:params:oauth:grant-type:token-exchange',subject_token:idp.access_token,subject_token_type:'urn:ietf:params:oauth:token-type:access_token',home_community_id:CARA,purpose_of_use:'NORM',role:'PAT',resource_id:spid});
const H={authorization:'Bearer '+xua.access_token};
const hc=d=>d.extension?.find(x=>x.url.endsWith('/homeCommunityId'))?.valueString;

const b=await (await fetch(`${FHIR}/DocumentReference?status=current,superseded&_revinclude=List:item`,{headers:H})).json();
const docs=b.entry.map(e=>e.resource).filter(r=>r.resourceType==='DocumentReference');
const caraHashes=new Set(docs.filter(d=>hc(d)===CARA).map(d=>d.content[0].attachment.hash));
const cands=docs.filter(d=>d.status==='current'&&hc(d)===X&&d.content[0].attachment.contentType==='application/pdf'&&!caraHashes.has(d.content[0].attachment.hash))
  .sort((a,b)=>(a.content[0].attachment.size||0)-(b.content[0].attachment.size||0));
console.log('current X PDFs not yet in CARA (by hash):',cands.map(d=>`${d.content[0].attachment.title} ${d.content[0].attachment.size}B ${d.content[0].format?.code}`));
const src=process.argv.includes('--title')?cands.find(d=>d.content[0].attachment.title.includes(process.argv[process.argv.indexOf('--title')+1])):cands[0];
if(!src){console.log('no candidate');process.exit(1);}
console.log('SOURCE:',src.content[0].attachment.title,'| hc',hc(src),'| type',src.type.coding[0].code,src.type.coding[0].display,'| category',src.category[0].coding[0].code,'| format',src.content[0].format?.code,'| lang',src.content[0].attachment.language,'| creation',src.content[0].attachment.creation,'| size',src.content[0].attachment.size,'| hash',src.content[0].attachment.hash);

// retrieve bytes
const rb=await fetch(src.content[0].attachment.url,{headers:H}); const bytes=Buffer.from(await rb.arrayBuffer());
const sha1=createHash('sha1').update(bytes).digest('base64');
console.log('retrieved',rb.status,rb.headers.get('content-type'),bytes.length,'bytes; sha1 matches metadata:',sha1===src.content[0].attachment.hash,'; PDF/A marker present:',bytes.includes('pdfaid:part'));

// build bundle exactly like the portal (fields the portal sends; server derives subject/sourcePatientInfo/homeCommunity)
const docUrn='urn:uuid:'+randomUUID(), partName='urn:uuid:'+randomUUID(), listId=randomUUID();
const oid='2.25.'+BigInt('0x'+randomUUID().replaceAll('-','')).toString();
const dr={resourceType:'DocumentReference',id:docUrn,
  contained:[{resourceType:'Practitioner',id:'2',name:[{family:name.family_name,given:[name.given_name]}]},{resourceType:'PractitionerRole',id:'1',practitioner:{reference:'#2'}}],
  masterIdentifier:{system:'urn:ietf:rfc:3986',value:oid},identifier:[{system:'urn:ietf:rfc:3986',value:docUrn}],status:'current',
  type:src.type,category:src.category,author:[{reference:'#1'}],securityLabel:src.securityLabel,
  content:[{attachment:{contentType:src.content[0].attachment.contentType,language:src.content[0].attachment.language,url:partName,size:bytes.length,hash:sha1,title:src.content[0].attachment.title,creation:src.content[0].attachment.creation},format:src.content[0].format}],
  context:{facilityType:src.context?.facilityType,practiceSetting:src.context?.practiceSetting}};
const list={resourceType:'List',id:listId,contained:[{resourceType:'PractitionerRole',id:'1',code:[{coding:[{system:'2.16.756.5.30.1.127.3.10.6',code:'PAT'}]}]}],
  extension:[{url:'http://profiles.ihe.net/ITI/MHD/StructureDefinition/ihe-designationType',valueCodeableConcept:{coding:[{system:'2.16.840.1.113883.6.96',code:'71388002',display:'Procedure (procedure)'}]}}],
  identifier:[{system:'urn:ietf:rfc:3986',value:'urn:oid:2.25.'+BigInt('0x'+randomUUID().replaceAll('-','')).toString()},{system:'urn:ietf:rfc:3986',value:'urn:uuid:'+randomUUID()}],
  status:'current',code:{coding:[{system:'http://profiles.ihe.net/ITI/MHD/CodeSystem/MHDlistTypes',code:'submissionset'}]},date:new Date().toISOString().replace(/\.\d{3}Z$/,'+00:00'),source:{reference:'#1'},entry:[{item:{reference:docUrn}}]};
const bundle={resourceType:'Bundle',meta:{profile:['http://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Comprehensive.ProvideBundle']},type:'transaction',entry:[{fullUrl:listId,resource:list},{fullUrl:docUrn,resource:dr}]};
if(process.argv.includes('--dry-run')){console.log('WOULD SEND bundle:',JSON.stringify(bundle,null,1).slice(0,3000));process.exit(0);}

const fd=new FormData();
fd.append('bundle',new Blob([JSON.stringify(bundle)],{type:'application/fhir+json'}));
fd.append(partName,new Blob([bytes],{type:src.content[0].attachment.contentType}));
const r=await fetch(`${FHIR}/`,{method:'POST',headers:H,body:fd});
const txt=await r.text(); console.log('UPLOAD ->',r.status,r.headers.get('content-type')); console.log(txt.slice(0,3000));
await new Promise(r=>setTimeout(r,3000));
const b2=await (await fetch(`${FHIR}/DocumentReference?status=current,superseded&_revinclude=List:item`,{headers:H})).json();
const nd=b2.entry.map(e=>e.resource).find(d=>d.resourceType==='DocumentReference'&&d.identifier?.some(i=>i.value===docUrn));
console.log('NEW DOC in list:',!!nd, nd?`| hc ${hc(nd)} | repo ${nd.extension.find(x=>x.url.endsWith('/repositoryUniqueId'))?.valueString} | subject ${nd.subject?.reference} | master ${nd.masterIdentifier.value} | hash ${nd.content[0].attachment.hash} | size ${nd.content[0].attachment.size}`:'');
if(nd){const rr=await fetch(nd.content[0].attachment.url,{headers:H}); const nb=Buffer.from(await rr.arrayBuffer()); console.log('retrieve new copy:',rr.status,nb.length,'bytes; identical to source:',nb.equals(bytes));}
