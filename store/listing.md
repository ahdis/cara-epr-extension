# Chrome Web Store listing — cara-transfer

Everything needed for the developer dashboard (https://chrome.google.com/webstore/devconsole). Copy the texts as they are; the store limits are respected (summary ≤ 132 characters, description ≤ 16 000).

## Package

- Upload `cara-transfer-<version>.zip` from the GitHub release of the tag `v<version>` (built by CI from the tagged commit, SHA-256 next to it). Do not zip the working directory by hand.
- Version in the store = `manifest.json` version.

## Store listing

**Name:** cara-transfer (taken from the manifest, localised)

**Summary** (from `_locales/*/messages.json`):

- en: Transfer, delete or back up your own EPR documents from other communities inside the CARA patient portal.
- de: Eigene EPD-Dokumente aus anderen Gemeinschaften im CARA-Patientenportal übertragen, löschen oder sichern.
- fr: Transférer, supprimer ou sauvegarder vos propres documents du DEP provenant d'autres communautés depuis le portail patient CARA.
- it: Trasferire, eliminare o salvare i propri documenti CIP provenienti da altre comunità dal portale pazienti CARA.

**Description (en):**

cara-transfer adds a side panel to the CARA patient portal (patient.cara.ch). While you are logged in, it lists your electronic patient record (EPR) documents that still live in another community, for example a community that is closing down, and lets you

- transfer them into CARA: the document is retrieved, its hash verified, uploaded to CARA as a new document submitted by you, verified byte for byte in CARA, saved as a local safety copy, and only then deleted in the other community;
- delete documents in the other community without copying them (for example old versions);
- back up any document, including CARA's own, to your computer as file plus metadata JSON.

Documents whose content already exists in CARA are recognised by their hash and never uploaded twice. Everything runs sequentially with a progress view, a local log and a stop button. Every destructive action needs an explicit acknowledgement in the same run. Only PDF and FHIR JSON documents are transferred; everything can be backed up.

Privacy: the extension talks only to the CARA backend (api-portals.cara.ch) from inside the portal page. There is no telemetry, no analytics, no third-party script and no remote configuration. Session tokens stay in your browser and are never stored by the extension. The source code is published under the Apache-2.0 licence.

**Description (de):**

cara-transfer ergänzt das CARA-Patientenportal (patient.cara.ch) um ein Seitenpanel. Solange Sie angemeldet sind, zeigt es Ihre EPD-Dokumente, die noch in einer anderen Gemeinschaft liegen (zum Beispiel einer Gemeinschaft, die ihren Betrieb einstellt), und erlaubt Ihnen,

- sie nach CARA zu übertragen: das Dokument wird abgerufen, sein Hash geprüft, als neues, von Ihnen eingereichtes Dokument nach CARA hochgeladen, dort Byte für Byte verifiziert, lokal als Sicherungskopie gespeichert und erst dann in der anderen Gemeinschaft gelöscht;
- Dokumente in der anderen Gemeinschaft ohne Kopie zu löschen (zum Beispiel alte Versionen);
- beliebige Dokumente, auch die in CARA, als Datei plus Metadaten-JSON auf Ihrem Computer zu sichern.

Dokumente, deren Inhalt bereits in CARA vorhanden ist, werden am Hash erkannt und nie doppelt hochgeladen. Alles läuft nacheinander mit Fortschrittsanzeige, lokalem Protokoll und Stopp-Taste. Jede unwiderrufliche Aktion verlangt eine ausdrückliche Bestätigung im selben Lauf. Übertragen werden PDF- und FHIR-JSON-Dokumente; sichern lässt sich alles.

Datenschutz: Die Erweiterung kommuniziert ausschliesslich mit dem CARA-Backend (api-portals.cara.ch), und zwar aus der Portalseite heraus. Keine Telemetrie, keine Analyse, keine Fremdskripte, keine Fernkonfiguration. Sitzungs-Tokens bleiben in Ihrem Browser und werden von der Erweiterung nie gespeichert. Der Quellcode ist unter der Apache-2.0-Lizenz veröffentlicht.

**Description (fr):**

cara-transfer ajoute un panneau latéral au portail patient CARA (patient.cara.ch). Pendant que vous êtes connecté·e, il liste vos documents du dossier électronique du patient (DEP) qui se trouvent encore dans une autre communauté, par exemple une communauté qui cesse son activité, et vous permet de

- les transférer dans CARA : le document est récupéré, son empreinte (hash) vérifiée, téléversé dans CARA comme nouveau document soumis par vous, vérifié octet par octet dans CARA, enregistré localement comme copie de sécurité, et seulement ensuite supprimé dans l'autre communauté ;
- supprimer des documents dans l'autre communauté sans les copier (par exemple d'anciennes versions) ;
- sauvegarder n'importe quel document, y compris ceux de CARA, sur votre ordinateur sous forme de fichier accompagné d'un JSON de métadonnées.

Les documents dont le contenu existe déjà dans CARA sont reconnus par leur empreinte et ne sont jamais téléversés deux fois. Tout s'exécute séquentiellement, avec une vue de progression, un journal local et un bouton d'arrêt. Chaque action irréversible exige une confirmation explicite dans la même exécution. Seuls les documents PDF et FHIR JSON sont transférés ; tout peut être sauvegardé.

Protection des données : l'extension communique uniquement avec le backend CARA (api-portals.cara.ch), depuis la page du portail. Pas de télémétrie, pas d'analyse, pas de script tiers, pas de configuration à distance. Les jetons de session restent dans votre navigateur et ne sont jamais stockés par l'extension. Le code source est publié sous licence Apache-2.0.

**Description (it):**

cara-transfer aggiunge un pannello laterale al portale pazienti CARA (patient.cara.ch). Mentre è collegato/a, elenca i documenti della sua cartella informatizzata del paziente (CIP) che si trovano ancora in un'altra comunità, per esempio una comunità che cessa l'attività, e le permette di

- trasferirli in CARA: il documento viene recuperato, il suo hash verificato, caricato in CARA come nuovo documento inviato da lei, verificato byte per byte in CARA, salvato localmente come copia di sicurezza e solo dopo eliminato nell'altra comunità;
- eliminare documenti nell'altra comunità senza copiarli (per esempio versioni precedenti);
- salvare qualsiasi documento, compresi quelli di CARA, sul suo computer come file più un JSON dei metadati.

I documenti il cui contenuto esiste già in CARA vengono riconosciuti dall'hash e non vengono mai caricati due volte. Tutto viene eseguito in sequenza, con una vista di avanzamento, un registro locale e un pulsante di arresto. Ogni azione irreversibile richiede una conferma esplicita nella stessa esecuzione. Vengono trasferiti solo documenti PDF e FHIR JSON; tutto può essere salvato.

Protezione dei dati: l'estensione comunica esclusivamente con il backend CARA (api-portals.cara.ch), dalla pagina del portale. Nessuna telemetria, nessuna analisi, nessuno script di terzi, nessuna configurazione remota. I token di sessione restano nel suo browser e non vengono mai memorizzati dall'estensione. Il codice sorgente è pubblicato con licenza Apache-2.0.


**Category:** Productivity → Tools (or "Health" if offered in your dashboard)

**Language:** German (default), plus English, French, Italian

**Screenshots (1280×800):** `store/store-1-list.png`, `store/store-2-disclaimer.png`, `store/store-3-progress.png` (taken from the offline test with anonymised sample data; no real patient data)

**Icon:** `icons/icon128.png`

**Homepage:** https://github.com/ahdis/cara-epr-extension

**Support:** the repository's issues page (or an ahdis contact address of your choice)

## Privacy practices tab

**Single purpose:** Transfer, delete or back up the logged-in patient's own EPR documents between communities inside the CARA patient portal. The extension collects no data for the developer: names, tokens and documents are processed only inside the browser and sent solely to the CARA backend that the portal itself uses; nothing is stored or transmitted elsewhere.

**Permission justifications:**

- `sidePanel`: the user interface is a side panel next to the portal.
- `storage`: local log of transfers/backups and the acceptance of the first-run notice; no tokens, no document content.
- `downloads`: writes backups and safety copies to Downloads/cara-backup/<date>/.
- Host permission `https://patient.cara.ch/*`: content script on the portal; it reads and refreshes the portal's own session tokens and performs the API requests with the portal's origin. No other host.

**Remote code:** No.

**Data usage:** the extension handles *health information* and *personally identifiable information* (name, EPR identifier) and *authentication information* (portal session tokens). All of it is processed locally in the browser and sent only to the CARA backend that the portal itself uses; nothing is sold, transferred to third parties, or used for purposes unrelated to the single purpose. Tick the three certification statements.

**Privacy policy URL:** raw link to `PRIVACY.md` in the repository, e.g. https://github.com/ahdis/cara-epr-extension/blob/main/PRIVACY.md (must be publicly reachable: either make the repository public or host the policy on ahdis.ch).

## Distribution tab

- **Visibility:** Private → "Trusted testers".
- **Trusted testers:** add the testers' Google account addresses (one per line). Testers install from the store URL of the item; they must be signed in to Chrome with that Google account.
- **Regions:** Switzerland (or all).
- Payments: free.

## After publishing

- Testers install via the item URL shown in the dashboard ("View in store"). Installation is only possible for the listed accounts; the page is not searchable.
- Every new version: bump `manifest.json` version, tag `v<version>`, upload the CI zip, submit for review. Private items are reviewed as well; a first review can take a few days.
- Before switching to Unlisted or Public: settle the client-id question with CARA, and complete the impressum in the first-run notice.
