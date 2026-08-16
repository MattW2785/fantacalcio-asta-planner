# Fantacalcio Asta Planner — Spec per Claude Code

## Obiettivo
Web app locale (single-page, no backend esterno necessario) che aiuta a preparare l'asta del Fantacalcio: quanto spendere per ruolo, quali giocatori convengono di più (rapporto punti attesi/prezzo), e un range di prezzo consigliato per ciascun giocatore del listone. Deve permettere di costruire la rosa live durante l'asta, tenendo traccia di crediti spesi/rimanenti e slot per ruolo, con dati persistenti tra sessioni.

## Dati disponibili
Nessun listone incorporato nell'app: il listone si carica dall'utente tramite un file Excel (`.xlsx`/`.xls`) o CSV, con un pulsante nel pannello "Listone giocatori". Il parsing avviene client-side con SheetJS (vendorizzato in locale in `vendor/xlsx.full.min.js`, nessuna dipendenza da rete).

- **Riconoscimento colonne**: automatico, per nome intestazione normalizzato (case-insensitive, senza spazi/punteggiatura) — `Id` (opzionale), `R`/`Ruolo` (P/D/C/A), `Nome`, `Squadra`, `Qt.A`/`Quotazione` (qa), `FVM`. Compatibile nativamente con l'export ufficiale "Quotazioni Fantacalcio" di fantacalcio.it (colonne `Id, R, RM, Nome, Squadra, Qt.A, Qt.I, Diff., Qt.A M, Qt.I M, Diff.M, FVM, FVM M` — le colonne `RM`/`Qt.A M`/`Qt.I`/`FVM M` vengono ignorate, si usano solo `R` classic, `Qt.A` e `FVM`).
- **Selezione foglio**: se il workbook ha più fogli, si usa quello chiamato "Tutti" (case-insensitive) se presente — è il formato del file ufficiale, che unisce i 4 ruoli ed esclude il foglio "Ceduti" — altrimenti il primo foglio.
- **Id mancanti o duplicati**: generati automaticamente in modo incrementale.
- **Righe non valide** (senza nome/squadra, o ruolo non in P/D/C/A): scartate e conteggiate nel messaggio di conferma import.
- **Sostituzione**: caricare un nuovo file sostituisce interamente il listone attivo e azzera la rosa (richiede conferma se c'era già un listone o una rosa in corso). Il listone caricato è persistito in `localStorage` e sopravvive al refresh.
- Schema interno per giocatore dopo il parsing:
  ```json
  {"id": 5841, "r": "P", "n": "Svilar", "s": "Roma", "qa": 18, "fvm": 65, "excl": false}
  ```
  - `r`: ruolo classic — `P` portiere, `D` difensore, `C` centrocampista, `A` attaccante
  - `n`: nome giocatore, `s`: squadra
  - `qa`: Quotazione Asta (prezzo di listino/riferimento)
  - `fvm`: FantaValore di Mercato (proxy della qualità/punti attesi — più alto = giocatore più forte)
  - `excl`: **ricalcolato sempre al momento dell'import** in base alla regola off-limits (vedi sotto) — non si fida di eventuali colonne off-limits presenti nel file sorgente

## Regole della lega (da REGOLAMENTO_FANTACAMPIONATO_26-27_SERIE_B.pdf)
- **Rosa**: 25 giocatori — 3 portieri, 8 difensori, 8 centrocampisti, 6 attaccanti (fisso, non editabile)
- **Budget**: 400 FantaMilioni (FM) totali, editabile dall'utente (default 400)
- **Numero squadre in lega**: l'utente ha dichiarato 6 (il regolamento parla di 8, discrepanza nota) — rendere il numero di squadre **configurabile**, default 6, perché influenza la scarsità/il mercato
- **Regola "off-limits"**: i primi 5 giocatori per quotazione (`qa`) più alta in ciascuno dei 3 reparti di movimento (D, C, A — NON i portieri) non sono acquistabili in nessuna sessione di mercato. Ricalcolata automaticamente a ogni import del listone (funzione `recomputeExclFlags` in `app.js`): per ogni ruolo in [D, C, A], prendere i 5 `qa` più alti e flaggare quei giocatori come `excl: true`.
- **Bonus/malus di scoring**: gol +3, assist +1 (tutti gli assist valgono uguale), ammonizione -0.5, espulsione -1, autogol -2, rigore parato +3, rigore sbagliato -3, gol subito -1 (portieri), porta inviolata +1 (modificatore difesa attivo), bonus capitano attivo, fattore campo non attivo. Questi pesi non vengono ricalcolati a mano: sono già applicati dalla `Fm` (Fantamedia) ufficiale nell'import statistiche (vedi sotto), che li usa esattamente così.

## Logica di valutazione da implementare

### 1. Range di prezzo consigliato per giocatore
Un fattore di mercato **unico e globale** (proporzionale a budget/500 e squadre/8) si è rivelato non realistico in un'asta a rialzo: schiaccia tutti i ruoli allo stesso modo, mentre nella pratica centrocampisti e attaccanti vengono pagati ben sopra quotazione (la domanda supera l'offerta di qualità) mentre portieri/difensori restano vicino o sotto quotazione. Il fattore va quindi calcolato **per ruolo**, confrontando quanti crediti la lega assegna a quel reparto con la quotazione dei giocatori che lo riempiranno davvero:

```
// per ciascun ruolo r in [P, D, C, A]:
slotTotaliRuolo = slotPerRuolo[r] * numeroSquadre
poolRuolo = migliori slotTotaliRuolo giocatori NON off-limits del ruolo r, ordinati per qa decrescente
qaSumRuolo = somma di qa nel poolRuolo
budgetRuolo = (percentualeRuolo[r] / 100) * budgetTotale * numeroSquadre

fattoreMercatoRuolo = (budgetRuolo / qaSumRuolo) * (correzionePct / 100)   // correzionePct editabile, default 100

prezzoMin = max(1, round(qa * fattoreMercatoRuolo * 0.75))
prezzoMax = max(prezzoMin + 1, round(qa * fattoreMercatoRuolo * 1.6))
```
Mostrare il fattore calcolato per ciascun ruolo (es. "fattore reparto: 2.06x quot.") e permettere all'utente di applicare una correzione percentuale globale (`correzionePct`, default 100%) per tarare tutti i range in base a come si comporta storicamente la propria lega — se i prezzi finali sono sistematicamente più alti o più bassi del previsto.

### 2. Indice di convenienza ("rapporto qualità/prezzo")
```
convenienza = fvm / max(qa, 1)
```
Calcolare il **percentile di convenienza all'interno dello stesso ruolo** (non confrontare ruoli diversi tra loro, hanno scale di FVM diverse) e usarlo per colorare/evidenziare i migliori affari (es. top 20% del ruolo = "ottimo affare", verde; medio = giallo; basso = grigio).

### 2bis. Rendimento reale (media voto, gol, assist, cartellini)
Import **separato e opzionale** dal listone: pulsante "Carica statistiche (Excel/CSV)" nel pannello "Listone giocatori", stesso meccanismo di parsing del listone (SheetJS, foglio "Tutti" se presente, ricerca automatica della riga di intestazione), colonne riconosciute `Nome`, `Squadra`, `Mv` (Media voto), `Fm` (Fantamedia), `Gf`, `Gs`, `Ass`, `Amm`, `Esp`, `Rp`, `Au` — compatibile con l'export ufficiale "Statistiche Fantacalcio" di fantacalcio.it. Abbinato al listone per `Id` (i due export condividono la numerazione), con fallback per nome+squadra normalizzati.

**Nessuna formula inventata**: la colonna "Rendimento" mostra direttamente la `Fm` (Fantamedia) ufficiale già calcolata da fantacalcio.it con i pesi del punto "Regole della lega" qui sopra (gol +3, assist +1, ammonizione -0.5, espulsione -1, gol subito -1 per i portieri, ecc.) — non va ricalcolata, ed essendo gol/assist pesati molto più delle ammonizioni/espulsioni, mette già "in secondo piano" chi prende cartellini senza bisogno di logica aggiuntiva. La colonna "Media" mostra la `Mv` (media voto) grezza. Percentile per ruolo come al punto 2 (top 20% = "ottimo rendimento").

**Focus automatico**: appena le statistiche vengono caricate, l'ordinamento della tabella passa da quotazione a Rendimento decrescente, così i giocatori con media voto alta e tanti gol/assist sono i primi che si vedono senza dover configurare nulla — resta comunque possibile ordinare per qualunque colonna. Giocatori del listone senza statistiche corrispondenti mostrano "—" in Media/Rendimento ma restano visibili normalmente (Convenienza e range prezzo non dipendono dalle statistiche).

### 3. Budget consigliato per ruolo
Percentuali di default modificabili dall'utente (devono sempre sommare 100%). Il regolamento suggerisce genericamente 6/16/34/44, ma applicate a questo listone producono fattori di mercato per ruolo molto squilibrati (P 0.74x, D 0.90x, C 1.51x, A 2.06x — vedi punto 1). I default sono quindi calibrati sui dati: proporzionali alla somma delle quotazioni (`qa`) dei giocatori realmente acquistabili che riempirebbero ciascun reparto (slot ruolo × numero squadre, esclusi gli off-limits), così il fattore di mercato risulta uniforme (~1.4x) su tutti i ruoli invece che concentrato su centrocampo/attacco:
- Portieri: 12%
- Difensori: 25%
- Centrocampisti: 32%
- Attaccanti: 31%

`creditiConsigliatiRuolo = percentuale * budgetTotale`, mostrare anche il prezzo medio per slot (`creditiConsigliatiRuolo / numeroSlotRuolo`, slot = 3/8/8/6). Restano comunque liberamente editabili dall'utente in qualsiasi momento.

## Funzionalità richieste
1. **Dashboard riepilogo** in alto: budget totale, speso finora, rimanente, slot rosa riempiti/totali per ruolo (3P/8D/8C/6A) — deve aggiornarsi live man mano che si aggiungono/rimuovono giocatori.
2. **Pannello impostazioni**: budget totale, numero squadre, override fattore mercato, percentuali budget per ruolo (con validazione somma=100%).
3. **Tabella giocatori** filtrabile per ruolo (tab P/D/C/A), con ricerca per nome/squadra, ordinabile per FVM, quotazione, media voto, rendimento, convenienza. Colonne: nome, squadra, quotazione (qa), FVM, media voto, rendimento (vedi punto 2bis, solo se le statistiche sono state importate — altrimenti "—"), convenienza (con indicatore colorato), range prezzo consigliato, azione "aggiungi alla rosa".
   - I giocatori con `excl: true` vanno mostrati ma disabilitati/in grigio con badge "non acquistabile" (tooltip che spiega la regola).
   - Bloccare l'aggiunta se lo slot del ruolo è già pieno o se il budget rimanente non copre nemmeno 1 credito per gli slot ancora vuoti (mantenere sempre almeno 1 credito per ogni slot vuoto rimanente).
4. **La mia rosa**: pannello/sezione con i giocatori selezionati raggruppati per ruolo, prezzo pagato (editabile, l'utente inserisce il prezzo reale di aggiudicazione in asta), possibilità di rimuovere.
5. **Persistenza**: salvare rosa e impostazioni in modo che sopravvivano al refresh (localStorage se è una vera web app locale; se sviluppata come artifact Claude, niente localStorage — usare lo stato in memoria o l'API di storage fornita dalla piattaforma).
6. **Nessun dato deve essere inventato**: tutti i calcoli derivano da `qa`/`fvm` del listone e, se importate, da `Mv`/`Fm` reali delle statistiche — nessuna formula sostitutiva quando mancano.
7. **Probabili titolari**: un piccolo simbolo (● verde) accanto al nome nella tabella indica i giocatori individuati come probabili titolari. **Nessun fallback automatico**: il pallino (e la vista "sfoglia" del pannello dedicato) restano vuoti finché l'utente non importa e **conferma** un PDF nel pannello "Probabili titolari" (vedi sezione dedicata sotto) — così non si mostra mai un dato potenzialmente vecchio come se fosse affidabile. Un pulsante "Svuota titolari" azzera l'import (il pallino torna a non comparire).

   Il pannello "Probabili titolari" permette inoltre di **sfogliare** i titolari correnti filtrando per ruolo e per squadra.

   *(Nota storica: `starters.js`, con una mappa `LIKELY_STARTERS` compilata a mano una tantum da un articolo, era usato come fallback iniziale finché non è stata introdotta questa importazione da PDF; il file resta nel repo come riferimento ma non è più caricato dall'app.)*

### Import PDF probabili titolari
Pensato per il PDF "Infografica" che fantacalcio.it pubblica periodicamente con le probabili formazioni di ogni squadra (schema tattico con pallini colorati per ruolo — giallo portieri, verde difensori, blu centrocampisti, rosso attaccanti — vedi `DocTitolari.pdf`), ma funziona con qualunque file dello stesso formato/palette.

**Perché OCR e non parsing diretto**: il PDF non contiene testo né vettori — ogni pagina è un'unica immagine raster incollata. Non è quindi possibile leggere i dati direttamente come si fa con l'Excel del listone (SheetJS); serve un pipeline immagine→testo, interamente client-side, vendorizzata in locale come le altre dipendenze (nessuna chiamata di rete):
1. **pdf.js** (`vendor/pdf.min.js` + `vendor/pdf.worker.min.js`) renderizza ogni pagina su un `<canvas>`.
2. I **riquadri squadra** vengono individuati cercando bande di righe/colonne quasi-bianche (soglia <1% pixel non bianchi) invece di coordinate fisse, così l'algoritmo si adatta se cambia il numero di righe/colonne del template.
3. Per ogni riquadro, i **pallini ruolo** vengono rilevati con un flood-fill sui colori (soglie RGB calibrate sulla palette fantacalcio.it), escludendo l'area di stemma/titolo squadra (ha colori simili e altrimenti genera falsi positivi) e la colonna Ballottaggi/Rigori/Punizioni (non serve).
4. **Tesseract.js** (`vendor/tesseract.min.js` + core WASM + dati lingua italiana, tutti vendorizzati in `vendor/`) fa l'OCR del riquadro; le parole riconosciute vengono raggruppate in etichette per prossimità spaziale (non per "riga" di tesseract, che unirebbe erroneamente etichette di giocatori diversi sulla stessa riga del campo ma distanti in orizzontale) e ogni etichetta viene abbinata al pallino più vicino → nome + ruolo.
5. Il nome riconosciuto viene abbinato al **giocatore del listone** (stessa squadra+ruolo) per corrispondenza esatta o per prefisso normalizzato (case/accenti-insensitive — gestisce troncamenti dell'OCR tipo "Vitinha"→"Vitinha O.").

**Limiti noti**: l'OCR può occasionalmente perdere un'etichetta in zone affollate del campo o leggere male un nome; per questo il risultato passa **sempre** da una revisione prima di essere salvato — coerente con il principio "nessun dato deve essere inventato" del punto 6. La pipeline è calibrata sul layout di questo template specifico; se fantacalcio.it lo cambia sostanzialmente il rilevamento può degradare (mitigato dalla revisione).

**Revisione e salvataggio squadra per squadra**: la revisione non è un'unica tabella con un conferma globale, ma una card per squadra (20 card per il PDF completo), ciascuna precompilata con caselle di spunta — una per ogni giocatore di quella squadra/ruolo nel listone, spuntate dove l'OCR ha trovato un abbinamento automatico. Sotto ogni card, se l'OCR ha rilevato nomi che non è riuscito ad abbinare, un avviso li elenca così l'utente può spuntarli a mano se corrispondono a un titolare. Ogni card ha il suo pulsante **"Salva squadra"**: salva subito solo quella squadra (badge "✓ Salvata", card che si ripiega per lasciare spazio alle successive — riespandibile cliccando l'intestazione) senza dover rivedere le altre 19. Un pulsante **"Salva tutte le squadre"** in cima applica in un colpo solo gli abbinamenti automatici a tutte le squadre, cosicché l'utente possa poi correggere solo le poche squadre segnalate invece di ripassarle tutte. "Chiudi revisione" chiude lo schermo di revisione (tutto ciò che è stato salvato con i pulsanti resta salvato; le squadre non ancora salvate restano semplicemente non aggiornate).

**Modifica di una squadra senza rifare l'import**: nella vista "sfoglia" del pannello, selezionando una squadra specifica nel filtro compare un pulsante **"Modifica squadra"** che apre lo stesso editor a caselle di spunta (precompilato con i titolari attualmente salvati per quella squadra, niente OCR coinvolto) per correggere al volo un solo giocatore — utile per un cambio dell'ultimo minuto senza dover ricaricare l'intero PDF.

**Storage e persistenza**: il salvataggio (per squadra, via "Salva squadra"/"Salva tutte"/editor manuale) aggiorna subito `titolariImport.entries` — sostituendo solo le voci della squadra toccata, lasciando intatte quelle delle altre — e persiste in `localStorage` insieme al resto dello stato; non c'è un passo di "conferma" separato che tiene tutto in sospeso. Il pulsante "Svuota titolari" azzera l'intero import: nessun pallino viene più mostrato finché non si salva di nuovo qualcosa.

## Direzione visiva
Tema scuro ispirato al campo da calcio / tabellone segnapunti da stadio, non il solito sfondo crema con accento terracotta.
- Palette: verde campo scurissimo per lo sfondo (`#0B2118`), pannelli in verde bosco (`#12291F`/`#17342A`), linee/bordi verde salvia spento (`#2C4C3B`), testo quasi bianco (`#ECEEE4`) con secondario verde-grigio (`#A9B8AC`), accento oro/ambra per tutto ciò che è "denaro/budget" (`#E3B23C`), rosso corallo per allerta/sforamento budget (`#D9614A`), verde acceso per "buon affare" (`#6FBF73`).
- Tipografia: un display condensato da tabellone/maglia sportiva per titoli e numeri di budget (es. Oswald), un sans neutro leggibile per il corpo (es. IBM Plex Sans), un monospace tabellare per tutti i numeri/importi (es. JetBrains Mono) — dà l'effetto "segnapunti/registro contabile".
- Badge ruolo con colori distinti e coerenti in tutta l'app: P ambra, D verde acqua, C blu indaco, A rosso corallo.
- Elemento distintivo: un "tabellone" riepilogo in alto con cifre in monospace grandi per budget speso/rimanente e mini-barre segmentate per lo stato di riempimento di ciascun reparto (stile "barra di formazione").
- Responsive, focus da tastiera visibile, animazioni minime e mirate (no effetti decorativi sparsi).

## Stack suggerito
Single-page app in HTML/CSS/JS vanilla oppure React — a scelta di Claude Code in base al contesto in cui verrà eseguita. Nessuna dipendenza da backend: tutto client-side, listone caricato dall'utente via Excel/CSV (parsing con SheetJS vendorizzato in locale).

Librerie vendorizzate in `vendor/` (nessuna dipendenza da rete a runtime): SheetJS (`xlsx.full.min.js`, listone), pdf.js (`pdf.min.js` + `pdf.worker.min.js`) e Tesseract.js (`tesseract.min.js` + core WASM + dati lingua italiana in `tessdata/`) per l'import PDF dei probabili titolari (vedi punto 7). Queste ultime due portano il peso offline dell'app da ~1MB a ~9-10MB — rilevante perché l'app viene installata su Home Screen su iOS/iPadOS (vedi service worker in `sw.js`).
