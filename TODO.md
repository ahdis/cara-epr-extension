The Swiss EPR is a electronic healh record system for the patient provided by Cara.
As a patient you can access the portal trough an official SwissID which is a standard
based OAuth flow, however you cannot get access over an (FHIR) API to submit or read documents.

With the upcoming cessation of Sanela to Cara I could move my documents to Cara however I'm
not 100% sure if only the metadata has been moved and not the document itself. This should
be visibly through the homecommunity, oid. I have seen that in the portal there are calls
in the network panel to get the metadata:

https://api-portals.cara.ch/ad-adaptor/api/r4/DocumentReference?status=current%2Csuperseded&_revinclude=List%3Aitem

As a result see DocumentReferenceOE.json

I would like to explore the following options:

1. Could you analyze the portal with Playwright and check the API calls, I'm considering developoing a chrome extension which could a) show the addiotnal metatdaa. Would it be even possible to expose the internal FHIR API DocumentReference call with an extension to offer as an external call why logged in so that I could read id with a command line tool or have it a. local mcp endpoint? I will log you into the portal as soon your in: https://patient.cara.ch/documents/

2. Can you analyze the metadata and provide it in a tabular form for masterIdentifier, type, category, Organinzation, Practionier, Patient homeCommunityId, repositoryUniqueId, ihe-sourceId for DocumentReferenceOE.json? 

