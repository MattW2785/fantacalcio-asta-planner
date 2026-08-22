(function () {
  'use strict';

  // ---------- Constants ----------
  const ROLES = ['P', 'D', 'C', 'A'];
  const ROLE_LABELS = { P: 'Portiere', D: 'Difensore', C: 'Centrocampista', A: 'Attaccante' };
  const ROLE_LABELS_PLURAL = { P: 'Portieri', D: 'Difensori', C: 'Centrocampisti', A: 'Attaccanti' };
  const SLOTS_PER_ROLE = { P: 3, D: 8, C: 8, A: 6 };
  const TOTAL_SLOTS = Object.values(SLOTS_PER_ROLE).reduce((a, b) => a + b, 0); // 25
  const STORAGE_KEY = 'fanta_asta_planner_v1';
  const SYNC_POLL_INTERVAL_MS = 2000;
  // Meno frequente del poll "mia rosa": interroga il roster di OGNI squadra della stanza per
  // sapere chi è già stato venduto altrove, quindi genera N richieste per giro invece di una
  // sola — non serve la stessa reattività di 2s per questo, e così si va più leggeri sul server.
  const ROOM_SOLD_POLL_INTERVAL_MS = 8000;

  const DEFAULT_SETTINGS = {
    budgetTotale: 400,
    numeroSquadre: 6,
    correzionePct: 100,
    pct: { P: 12, D: 25, C: 32, A: 31 }
  };

  // Collegamento con Asta Live Fantacalcio (asta in tempo reale, app separata): quando attivo,
  // i giocatori acquistati dalla squadra scelta vengono aggiunti automaticamente qui.
  const DEFAULT_SYNC = {
    baseUrl: 'https://asta-live-fantacalcio-production.up.railway.app',
    roomCode: '',
    teamId: null,
    teamName: null,
    lastSyncedAt: null,
    lastError: null,
    // Chiavi (nome|squadra) di giocatori sincronizzati che l'utente ha rimosso a mano dalla
    // rosa: non vanno ri-aggiunti automaticamente al prossimo poll.
    ignoreKeys: [],
    // Disponibilità dell'intero listone: chiave "nome|squadra" -> nome della squadra che lo ha
    // acquistato, aggregando il roster di TUTTE le squadre della stanza (non solo la propria).
    soldByTeam: {},
    soldTeamsOk: 0,
    soldTeamsTotal: 0,
    soldLastSyncedAt: null
  };

  // Strategie di allocazione budget consigliate, selezionabili nel pannello impostazioni.
  const PCT_PRESETS = [
    { key: 'equilibrato', pct: { P: 12, D: 25, C: 32, A: 31 } },
    { key: 'attacco', pct: { P: 8, D: 20, C: 28, A: 44 } },
    { key: 'centrocampo', pct: { P: 8, D: 20, C: 40, A: 32 } },
    { key: 'difesa', pct: { P: 16, D: 32, C: 28, A: 24 } }
  ];

  // Usate solo come fallback per abbinare il nome squadra letto dal PDF titolari quando il
  // listone non è ancora stato caricato (altrimenti si usano le squadre presenti nel listone).
  const KNOWN_TEAM_NAMES_FALLBACK = [
    'Atalanta', 'Bologna', 'Cagliari', 'Como', 'Fiorentina', 'Frosinone', 'Genoa', 'Inter',
    'Juventus', 'Lazio', 'Lecce', 'Milan', 'Monza', 'Napoli', 'Parma', 'Roma', 'Sassuolo',
    'Torino', 'Udinese', 'Venezia'
  ];

  // ---------- State ----------
  const initial = loadState();
  let settings = initial.settings;
  let roster = initial.roster; // [{id, pricePaid, synced?}]
  let PLAYERS_DATA = initial.players; // caricato da file Excel/CSV, nessun listone incorporato
  let playersMeta = initial.playersMeta; // { fileName, importedAt } | null
  let STATS_DATA = initial.stats; // statistiche reali (Mv/Fm/Gf/Ass/Amm/Esp/...), import separato e opzionale
  let statsMeta = initial.statsMeta; // { fileName, importedAt } | null
  let sync = initial.sync; // collegamento con Asta Live (vedi DEFAULT_SYNC)
  // Probabili titolari importati da PDF (vedi sezione dedicata più sotto): quando presente,
  // sostituisce integralmente il fallback statico LIKELY_STARTERS di starters.js.
  let titolariImport = initial.titolariImport; // { entries:[{id,n,s,r}], meta:{...} } | null
  // Archivio di "fotografie" della rosa salvate a mano dall'utente (nome/data + elenco
  // giocatori con prezzo pagato), indipendenti dalla rosa live: restano intatte anche se poi
  // si svuota o si modifica "La mia rosa". Usate per l'export PDF e per confrontare versioni.
  let savedFormations = initial.savedFormations; // [{id, name, savedAt, budgetTotale, entries:[{n,s,r,pricePaid}]}]
  let activeRole = 'P';
  let searchTerm = '';
  let sortKey = 'qa';
  let sortDir = 'desc';
  let hideSold = true; // nasconde dal Listone i giocatori già acquistati da qualsiasi squadra della stanza

  let playersById = new Map();
  // Giocatori realmente acquistabili (non off-limits) per ruolo, ordinati per quotazione decrescente:
  // servono per stimare quanti crediti "assorbirà" davvero ciascun reparto.
  let NON_EXCL_SORTED_BY_ROLE = { P: [], D: [], C: [], A: [] };
  // Indice per il matching con Asta Live: chiave "nome|squadra" normalizzata -> giocatore del listone.
  let matchIndexByKey = new Map();

  function rebuildDerivedIndexes() {
    playersById = new Map(PLAYERS_DATA.map(p => [p.id, p]));
    NON_EXCL_SORTED_BY_ROLE = { P: [], D: [], C: [], A: [] };
    ROLES.forEach(role => {
      NON_EXCL_SORTED_BY_ROLE[role] = PLAYERS_DATA.filter(p => p.r === role && !p.excl).sort((a, b) => b.qa - a.qa);
    });
    matchIndexByKey = new Map();
    PLAYERS_DATA.forEach(p => {
      const key = normalizeMatchKey(p.n, p.s);
      if (!matchIndexByKey.has(key)) matchIndexByKey.set(key, p);
    });
    rebuildStatsIndex();
    computeConvenienzaTiers();
    computeRendimentoTiers();
  }

  // Statistiche reali (Mv/Fm/...) abbinate al listone per Id, con fallback nome+squadra
  // normalizzati (i due file di fantacalcio.it di solito condividono gli Id, ma non è garantito).
  let statsById = new Map();
  let statsByNameTeam = new Map();
  function rebuildStatsIndex() {
    statsById = new Map(STATS_DATA.map(s => [s.id, s]));
    statsByNameTeam = new Map();
    STATS_DATA.forEach(s => {
      const key = normalizeMatchKey(s.n, s.s);
      if (!statsByNameTeam.has(key)) statsByNameTeam.set(key, s);
    });
  }

  function statsForPlayer(p) {
    return statsById.get(p.id) || statsByNameTeam.get(normalizeMatchKey(p.n, p.s)) || null;
  }

  // ---------- Persistence ----------
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { settings: { ...DEFAULT_SETTINGS, pct: { ...DEFAULT_SETTINGS.pct } }, roster: [], players: [], playersMeta: null, stats: [], statsMeta: null, sync: { ...DEFAULT_SYNC }, titolariImport: null, savedFormations: [] };
      const parsed = JSON.parse(raw);
      return {
        settings: { ...DEFAULT_SETTINGS, ...parsed.settings, pct: { ...DEFAULT_SETTINGS.pct, ...(parsed.settings && parsed.settings.pct) } },
        roster: Array.isArray(parsed.roster) ? parsed.roster : [],
        players: Array.isArray(parsed.players) ? parsed.players : [],
        playersMeta: parsed.playersMeta || null,
        stats: Array.isArray(parsed.stats) ? parsed.stats : [],
        statsMeta: parsed.statsMeta || null,
        sync: {
          ...DEFAULT_SYNC,
          ...(parsed.sync || {}),
          ignoreKeys: Array.isArray(parsed.sync && parsed.sync.ignoreKeys) ? parsed.sync.ignoreKeys : []
        },
        titolariImport: (parsed.titolariImport && Array.isArray(parsed.titolariImport.entries)) ? parsed.titolariImport : null,
        savedFormations: Array.isArray(parsed.savedFormations) ? parsed.savedFormations : []
      };
    } catch (e) {
      return { settings: { ...DEFAULT_SETTINGS, pct: { ...DEFAULT_SETTINGS.pct } }, roster: [], players: [], playersMeta: null, stats: [], statsMeta: null, sync: { ...DEFAULT_SYNC }, titolariImport: null, savedFormations: [] };
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, roster, players: PLAYERS_DATA, playersMeta, stats: STATS_DATA, statsMeta, sync, titolariImport, savedFormations }));
  }

  // ---------- Derived calculations ----------
  // Fattore di mercato PER RUOLO: quanti crediti la lega assegna in media a un punto di
  // quotazione in quel reparto. Si ottiene confrontando il budget complessivo destinato al
  // ruolo (percentuale x budget x squadre) con la somma delle quotazioni dei giocatori che,
  // dato il numero di squadre, andranno realmente riempiti in quel reparto (i migliori N
  // acquistabili, N = slot ruolo x squadre). In un'asta a rialzo un fattore > 1 significa che
  // il reparto viene mediamente pagato SOPRA quotazione (tipico di centrocampisti/attaccanti,
  // dove la domanda supera l'offerta "di qualità"); < 1 significa che resta sotto quotazione.
  function fattoreMercatoRuolo(role) {
    const slotsTotali = SLOTS_PER_ROLE[role] * settings.numeroSquadre;
    const pool = NON_EXCL_SORTED_BY_ROLE[role].slice(0, slotsTotali);
    const qaSum = pool.reduce((s, p) => s + p.qa, 0) || 1;
    const budgetRuolo = (settings.pct[role] / 100) * settings.budgetTotale * settings.numeroSquadre;
    const base = budgetRuolo / qaSum;
    return base * (settings.correzionePct / 100);
  }

  function computeRoleFactors() {
    const factors = {};
    ROLES.forEach(role => { factors[role] = fattoreMercatoRuolo(role); });
    return factors;
  }

  function priceRange(qa, factor) {
    // Il minimo consigliato non scende mai a/sotto la quotazione: in un'asta a rialzo si parte
    // da lì, quindi il prezzo "atteso" realistico è sempre almeno quotazione+1.
    const min = Math.max(1, qa + 1, Math.round(qa * factor * 0.75));
    const max = Math.max(min + 1, Math.round(qa * factor * 1.6));
    return { min, max };
  }

  function convenienza(p) {
    return p.fvm / Math.max(p.qa, 1);
  }

  // percentile tiers per role, computed once per render pass (data is static)
  let convenienzaTiers = null; // Map<id, 'ottimo'|'buono'|'basso'>
  function computeConvenienzaTiers() {
    const map = new Map();
    ROLES.forEach(role => {
      const list = PLAYERS_DATA.filter(p => p.r === role)
        .map(p => ({ id: p.id, conv: convenienza(p) }))
        .sort((a, b) => b.conv - a.conv);
      const n = list.length;
      list.forEach((entry, idx) => {
        const fraction = (idx + 1) / n;
        let tier;
        if (fraction <= 0.2) tier = 'ottimo';
        else if (fraction <= 0.5) tier = 'buono';
        else tier = 'basso';
        map.set(entry.id, tier);
      });
    });
    convenienzaTiers = map;
  }

  // Media voto e Fantamedia reali (da import "Statistiche Fantacalcio", opzionale — vedi
  // wireStatsImport). La Fantamedia è già il valore ufficiale calcolato da fantacalcio.it con
  // le regole di punteggio della lega (gol +3, assist +1, ammonizione -0.5, espulsione -1, gol
  // subito -1 per i portieri, ecc. — vedi SPEC.md "Regole della lega"): non va ricalcolata,
  // riflette già "media voto alta + molti gol/assist, cartellini pesano poco" chiesto per il
  // focus automatico, per ogni ruolo portieri inclusi (gol subiti già scontati lì dentro).
  function mediaVoto(p) {
    const s = statsForPlayer(p);
    return s && s.pv > 0 ? s.mv : null;
  }

  function rendimento(p) {
    const s = statsForPlayer(p);
    return s && s.pv > 0 ? s.fm : null;
  }

  // percentile tiers per role, solo tra i giocatori con statistiche disponibili
  let rendimentoTiers = null; // Map<id, 'ottimo'|'buono'|'basso'>
  function computeRendimentoTiers() {
    const map = new Map();
    ROLES.forEach(role => {
      const list = PLAYERS_DATA.filter(p => p.r === role && rendimento(p) !== null)
        .map(p => ({ id: p.id, fm: rendimento(p) }))
        .sort((a, b) => b.fm - a.fm);
      const n = list.length;
      list.forEach((entry, idx) => {
        const fraction = (idx + 1) / n;
        let tier;
        if (fraction <= 0.2) tier = 'ottimo';
        else if (fraction <= 0.5) tier = 'buono';
        else tier = 'basso';
        map.set(entry.id, tier);
      });
    });
    rendimentoTiers = map;
  }

  function filledCounts() {
    const counts = { P: 0, D: 0, C: 0, A: 0 };
    roster.forEach(r => {
      const p = playersById.get(r.id);
      if (p) counts[p.r]++;
    });
    return counts;
  }

  function totalSpeso() {
    return roster.reduce((sum, r) => sum + (Number(r.pricePaid) || 0), 0);
  }

  function roleSpeso(role) {
    return roster.reduce((sum, r) => {
      const p = playersById.get(r.id);
      return p && p.r === role ? sum + (Number(r.pricePaid) || 0) : sum;
    }, 0);
  }

  function roleBudgetConsigliato(role) {
    return (settings.pct[role] / 100) * settings.budgetTotale;
  }

  // Ribilancia il budget rimanente tra i ruoli non ancora completi, in proporzione alle
  // percentuali impostate. Un ruolo già pieno esce dal calcolo e il suo "peso" si redistribuisce
  // sugli altri; se si sfora in un ruolo, il budget disponibile per tutti gli altri si restringe
  // di conseguenza — è la vera disponibilità residua, non solo (piano - speso) di quel ruolo.
  function computeRebalancedRoleTargets() {
    const counts = filledCounts();
    const totalRemaining = settings.budgetTotale - totalSpeso();
    const activeRoles = ROLES.filter(role => counts[role] < SLOTS_PER_ROLE[role]);
    const weightSum = activeRoles.reduce((sum, role) => sum + Number(settings.pct[role] || 0), 0) || 1;
    const targets = {};
    ROLES.forEach(role => {
      if (counts[role] >= SLOTS_PER_ROLE[role]) {
        targets[role] = 0;
        return;
      }
      targets[role] = totalRemaining * (Number(settings.pct[role] || 0) / weightSum);
    });
    return targets;
  }

  function emptySlotsTotal(counts) {
    return ROLES.reduce((sum, role) => sum + Math.max(0, SLOTS_PER_ROLE[role] - counts[role]), 0);
  }

  // ---------- Add / remove / edit roster ----------
  function canAddPlayer(player, price) {
    if (player.excl) return { ok: false, reason: 'Giocatore non acquistabile (regola off-limits).' };
    const counts = filledCounts();
    if (counts[player.r] >= SLOTS_PER_ROLE[player.r]) {
      return { ok: false, reason: `Slot ${ROLE_LABELS[player.r]} già al completo (${SLOTS_PER_ROLE[player.r]}/${SLOTS_PER_ROLE[player.r]}).` };
    }
    const newCounts = { ...counts, [player.r]: counts[player.r] + 1 };
    const emptyAfter = emptySlotsTotal(newCounts);
    const remainingAfter = settings.budgetTotale - (totalSpeso() + price);
    if (remainingAfter < emptyAfter) {
      return { ok: false, reason: 'Budget insufficiente: deve restare almeno 1 credito per ogni slot ancora vuoto.' };
    }
    return { ok: true };
  }

  function canSetPrice(playerId, newPrice) {
    const counts = filledCounts();
    const emptyAfter = emptySlotsTotal(counts);
    const currentSpesoOthers = roster.reduce((sum, r) => sum + (r.id === playerId ? 0 : (Number(r.pricePaid) || 0)), 0);
    const remainingAfter = settings.budgetTotale - (currentSpesoOthers + newPrice);
    if (remainingAfter < emptyAfter) {
      return { ok: false, reason: 'Budget insufficiente: deve restare almeno 1 credito per ogni slot ancora vuoto.' };
    }
    return { ok: true };
  }

  function addPlayer(id) {
    const player = playersById.get(id);
    if (!player) return;
    const defaultPrice = 1;
    const check = canAddPlayer(player, defaultPrice);
    if (!check.ok) {
      showToast(check.reason, 'error');
      return;
    }
    roster.push({ id, pricePaid: defaultPrice });
    saveState();
    renderAll();
    const rimanenteRuolo = computeRebalancedRoleTargets()[player.r];
    showToast(`${player.n} aggiunto (${ROLE_LABELS[player.r]}). Rimanente ribilanciato per il ruolo: ${rimanenteRuolo.toFixed(0)} FM.`);
  }

  function removePlayer(id) {
    const entry = roster.find(r => r.id === id);
    if (entry && entry.synced) {
      const player = playersById.get(id);
      if (player) {
        const key = normalizeMatchKey(player.n, player.s);
        if (!sync.ignoreKeys.includes(key)) sync.ignoreKeys.push(key);
        showToast(`${player.n} rimosso e disattivato dalla sincronizzazione automatica. Puoi riattivarlo dal pannello "Asta Live".`);
      }
    }
    roster = roster.filter(r => r.id !== id);
    saveState();
    renderAll();
  }

  // Riattiva la sincronizzazione automatica per un giocatore rimosso a mano in precedenza, e
  // ricontrolla subito cosi' torna in rosa immediatamente se risulta ancora acquistato.
  function unignoreKey(key) {
    sync.ignoreKeys = sync.ignoreKeys.filter(k => k !== key);
    saveState();
    renderSyncPanel();
    syncTick();
  }

  function setPrice(id, price) {
    price = Math.max(0, Math.round(Number(price) || 0));
    const entry = roster.find(r => r.id === id);
    if (!entry) return;
    entry.pricePaid = price;
    saveState();
    renderAll();
  }

  // ---------- Toast ----------
  let toastTimer = null;
  function showToast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('toast-error', 'toast-ok');
    el.classList.add('show', type === 'error' ? 'toast-error' : 'toast-ok');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  // ---------- Confirm modal ----------
  // Sostituisce window.confirm(): nelle web-app aggiunte alla schermata Home su iOS
  // (display standalone) i dialog nativi confirm/alert/prompt possono non comparire affatto,
  // bloccando silenziosamente l'azione. Questo modal disegnato in pagina funziona ovunque.
  function showConfirm(message) {
    return new Promise(resolve => {
      const overlay = document.getElementById('confirm-modal');
      document.getElementById('confirm-modal-message').textContent = message;
      overlay.hidden = false;

      const cleanup = (result) => {
        overlay.hidden = true;
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onOverlayClick);
        resolve(result);
      };
      const okBtn = document.getElementById('confirm-modal-ok');
      const cancelBtn = document.getElementById('confirm-modal-cancel');
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onOverlayClick = (e) => { if (e.target === overlay) cleanup(false); };

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      overlay.addEventListener('click', onOverlayClick);
    });
  }

  // ---------- Rendering: Dashboard ----------
  function renderDashboard() {
    const speso = totalSpeso();
    const remaining = settings.budgetTotale - speso;
    const counts = filledCounts();
    const filledTotal = ROLES.reduce((s, r) => s + counts[r], 0);

    document.getElementById('fig-budget').textContent = settings.budgetTotale;
    document.getElementById('fig-spent').textContent = speso;
    const remainingEl = document.getElementById('fig-remaining');
    remainingEl.textContent = remaining;
    remainingEl.classList.toggle('over', remaining < 0);
    document.getElementById('fig-slots').textContent = `${filledTotal}/${TOTAL_SLOTS}`;

    const barsContainer = document.getElementById('formation-bars');
    barsContainer.innerHTML = '';
    ROLES.forEach(role => {
      const row = document.createElement('div');
      row.className = 'formation-row';
      const segWrap = document.createElement('div');
      segWrap.className = 'formation-segments';
      for (let i = 0; i < SLOTS_PER_ROLE[role]; i++) {
        const seg = document.createElement('span');
        seg.className = 'segment' + (i < counts[role] ? ` filled role-${role}` : '');
        segWrap.appendChild(seg);
      }
      const label = document.createElement('span');
      label.textContent = `${role} ${counts[role]}/${SLOTS_PER_ROLE[role]}`;
      row.appendChild(segWrap);
      row.appendChild(label);
      barsContainer.appendChild(row);
    });
  }

  // ---------- Rendering: Settings ----------
  function renderSettings() {
    document.getElementById('input-budget').value = settings.budgetTotale;
    document.getElementById('input-teams').value = settings.numeroSquadre;
    document.getElementById('input-correzione').value = settings.correzionePct;

    ROLES.forEach(role => {
      document.getElementById(`pct-${role}`).value = settings.pct[role];
    });

    updatePctStatus();
    renderRoleBudgetSummary();
    highlightActivePreset();
  }

  function highlightActivePreset() {
    const activeKey = (PCT_PRESETS.find(p => ROLES.every(role => p.pct[role] === Number(settings.pct[role]))) || {}).key;
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.preset === activeKey);
    });
  }

  function updatePctStatus() {
    const sum = ROLES.reduce((s, r) => s + Number(settings.pct[r] || 0), 0);
    const statusEl = document.getElementById('pct-status');
    if (sum === 100) {
      statusEl.textContent = `Somma percentuali: ${sum}% ✓`;
      statusEl.className = 'pct-status ok';
    } else {
      statusEl.textContent = `Somma percentuali: ${sum}% — deve essere 100%`;
      statusEl.className = 'pct-status error';
    }
    return sum === 100;
  }

  function renderRoleBudgetSummary() {
    const container = document.getElementById('role-budget-summary');
    container.innerHTML = '';
    const factors = computeRoleFactors();
    const counts = filledCounts();
    const rebalanced = computeRebalancedRoleTargets();
    ROLES.forEach(role => {
      const pianoIniziale = roleBudgetConsigliato(role);
      const avg = pianoIniziale / SLOTS_PER_ROLE[role];
      const hasPlayers = NON_EXCL_SORTED_BY_ROLE[role].length > 0;
      const factor = factors[role];
      const speso = roleSpeso(role);
      const emptySlots = SLOTS_PER_ROLE[role] - counts[role];
      const rimanente = rebalanced[role];
      const mediaSlot = emptySlots > 0 ? rimanente / emptySlots : 0;
      const pctUsed = pianoIniziale > 0 ? Math.min(100, (speso / pianoIniziale) * 100) : 0;
      const over = speso > pianoIniziale;
      const card = document.createElement('div');
      card.className = 'role-budget-card';
      card.innerHTML = `
        <div class="rb-card-top">
          <span class="role-tag role-${role}">${role}</span>
          <span class="rb-role-label">${ROLE_LABELS_PLURAL[role]}</span>
        </div>
        <div class="rb-main-figures">
          <div class="rb-main-figure">
            <span class="rb-main-label">Budget piano</span>
            <span class="rb-main-value">${pianoIniziale.toFixed(0)} <small>FM</small></span>
          </div>
          <div class="rb-main-figure">
            <span class="rb-main-label">Speso</span>
            <span class="rb-main-value${over ? ' rb-over' : ''}">${speso.toFixed(0)} <small>FM</small></span>
          </div>
        </div>
        <div class="rb-bar-wrap"><div class="rb-bar-fill${over ? ' over' : ''}" style="width:${pctUsed}%"></div></div>
        <div class="rb-details">
          <span>~${avg.toFixed(1)} FM/slot</span>
          <span>fattore reparto: ${hasPlayers ? factor.toFixed(2) + 'x quot.' : '— (carica il listone)'}</span>
          <span>ribilanciato <span class="${rimanente < 0 ? 'rb-over' : ''}">${rimanente.toFixed(0)}</span> FM${emptySlots > 0 ? ` (~${mediaSlot.toFixed(1)}/slot)` : ' (completo)'}</span>
        </div>
      `;
      container.appendChild(card);
    });
  }

  // ---------- Rendering: per-role spend strip (sopra la tabella, segue il tab attivo) ----------
  function renderRoleSpendStrip() {
    const strip = document.getElementById('role-spend-strip');
    const speso = roleSpeso(activeRole);
    const rebalanced = computeRebalancedRoleTargets();
    const rimanente = rebalanced[activeRole];
    const counts = filledCounts();
    const emptySlots = SLOTS_PER_ROLE[activeRole] - counts[activeRole];
    const poolRuolo = speso + rimanente; // quota totale (già spesa + ancora disponibile) ricalcolata sul budget rimanente
    const pctUsed = poolRuolo > 0 ? Math.min(100, Math.max(0, (speso / poolRuolo) * 100)) : 0;
    const over = rimanente < 0;
    const mediaSlot = emptySlots > 0 ? rimanente / emptySlots : 0;

    strip.innerHTML = `
      <span class="role-tag role-${activeRole}">${activeRole}</span>
      <span class="rss-figure"><span class="rss-label">Speso</span><span class="rss-value">${speso.toFixed(0)} FM</span></span>
      <div class="rss-bar-wrap"><div class="rss-bar-fill${over ? ' over' : ''}" style="width:${pctUsed}%"></div></div>
      <span class="rss-figure"><span class="rss-label">Rimanente (ribilanciato)</span><span class="rss-value rss-remaining${over ? ' over' : ''}">${rimanente.toFixed(0)} FM</span></span>
      ${emptySlots > 0 ? `<span class="rss-figure"><span class="rss-label">Media/slot libero</span><span class="rss-value">${mediaSlot.toFixed(1)} FM</span></span>` : '<span class="rss-figure"><span class="rss-label">Ruolo</span><span class="rss-value">completo</span></span>'}
    `;
  }

  // Mostra/nasconde il toggle "Nascondi venduti" e il relativo stato solo quando collegati a
  // una stanza Asta Live (altrimenti non c'è alcun dato "venduto" da mostrare/nascondere).
  function renderSoldSyncStatus() {
    const wrap = document.getElementById('hide-sold-wrap');
    const hint = document.getElementById('sold-sync-hint');
    const linked = !!sync.teamId;
    wrap.hidden = !linked;
    hint.hidden = !linked;
    if (!linked) return;

    const ok = sync.soldTeamsOk || 0;
    const total = sync.soldTeamsTotal || 0;
    const when = sync.soldLastSyncedAt ? new Date(sync.soldLastSyncedAt).toLocaleTimeString('it-IT') : 'mai';
    let text = `Disponibilità listone: ${ok}/${total || '?'} squadre della stanza sincronizzate (ultimo controllo ${when}).`;
    if (total > 0 && ok < total) {
      text += ' Attiva la sincronizzazione anche per le altre squadre da Asta Live per un quadro completo.';
    }
    hint.textContent = text;
  }

  // ---------- Rendering: Players table ----------
  function renderTable() {
    renderRoleSpendStrip();
    renderSoldSyncStatus();

    const tbody = document.getElementById('players-tbody');
    tbody.innerHTML = '';

    let list = PLAYERS_DATA.filter(p => p.r === activeRole);

    if (searchTerm.trim()) {
      const q = searchTerm.trim().toLowerCase();
      list = list.filter(p => p.n.toLowerCase().includes(q) || p.s.toLowerCase().includes(q));
    }

    if (hideSold) {
      list = list.filter(p => !isSoldElsewhere(p));
    }

    list = list.slice().sort((a, b) => {
      let va, vb;
      if (sortKey === 'qa') { va = a.qa; vb = b.qa; }
      else if (sortKey === 'fvm') { va = a.fvm; vb = b.fvm; }
      else if (sortKey === 'mv') { va = mediaVoto(a) ?? -Infinity; vb = mediaVoto(b) ?? -Infinity; }
      else if (sortKey === 'fm') { va = rendimento(a) ?? -Infinity; vb = rendimento(b) ?? -Infinity; }
      else { va = convenienza(a); vb = convenienza(b); }
      return sortDir === 'asc' ? va - vb : vb - va;
    });

    document.querySelectorAll('#players-table th.sortable').forEach(th => {
      th.classList.toggle('sort-active', th.dataset.sort === sortKey);
      th.textContent = th.textContent.replace(/ [▲▼]$/, '');
      if (th.dataset.sort === sortKey) {
        th.textContent += sortDir === 'asc' ? ' ▲' : ' ▼';
      }
    });

    const rosterIds = new Set(roster.map(r => r.id));
    const counts = filledCounts();
    const roleFactor = fattoreMercatoRuolo(activeRole);

    if (list.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="9" class="no-results">Nessun giocatore trovato.</td>`;
      tbody.appendChild(tr);
      return;
    }

    list.forEach(p => {
      const tr = document.createElement('tr');
      const inRoster = rosterIds.has(p.id);
      const tier = convenienzaTiers.get(p.id);
      const tierLabel = { ottimo: 'Ottimo affare', buono: 'Buon rapporto', basso: 'Nella media' }[tier];
      const range = priceRange(p.qa, roleFactor);
      const conv = convenienza(p);

      const mv = mediaVoto(p);
      const fm = rendimento(p);
      const rendTier = rendimentoTiers.get(p.id);
      const rendTierLabel = { ottimo: 'Ottimo rendimento', buono: 'Buon rendimento', basso: 'Nella media' }[rendTier];
      const rendCell = fm !== null
        ? `<span class="conv-badge conv-${rendTier}"><span class="conv-dot"></span>${fm.toFixed(2)} · ${rendTierLabel}</span>`
        : '<span class="hint">—</span>';

      if (p.excl) tr.classList.add('excluded');
      const soldTeam = sync.soldByTeam ? sync.soldByTeam[normalizeMatchKey(p.n, p.s)] : null;
      const isSold = isSoldElsewhere(p);
      if (isSold) tr.classList.add('sold-elsewhere');
      const soldBadge = isSold
        ? ` <span class="excl-badge sold-badge" title="Già acquistato da ${escapeHtml(soldTeam)} su Asta Live">venduto</span>`
        : '';

      const slotFull = counts[p.r] >= SLOTS_PER_ROLE[p.r];
      const disableAdd = p.excl || inRoster || slotFull || isSold;
      let addLabel = 'Aggiungi';
      if (inRoster) addLabel = 'In rosa';
      else if (isSold) addLabel = 'Venduto';
      else if (p.excl) addLabel = 'Non acq.';
      else if (slotFull) addLabel = 'Slot pieno';

      const starterKey = (p.n.trim() + '|' + p.s.trim()).toLowerCase();
      const isStarter = activeStartersMap()[starterKey];
      const starterMark = isStarter
        ? `<span class="starter-dot" title="${escapeHtml(startersTitle())}">●</span> `
        : '';

      tr.innerHTML = `
        <td class="player-name">${starterMark}${escapeHtml(p.n)}${p.excl ? ' <span class="excl-badge" title="Tra i 5 giocatori più quotati del ruolo: non acquistabile per regola di lega (off-limits)">off-limits</span>' : ''}${soldBadge}</td>
        <td>${escapeHtml(p.s)}</td>
        <td class="mono-cell">${p.qa}</td>
        <td class="mono-cell">${p.fvm}</td>
        <td class="mono-cell">${mv !== null ? mv.toFixed(2) : '—'}</td>
        <td>${rendCell}</td>
        <td><span class="conv-badge conv-${tier}"><span class="conv-dot"></span>${conv.toFixed(1)} · ${tierLabel}</span></td>
        <td class="price-range">${range.min}&ndash;${range.max} FM</td>
        <td><button class="btn btn-add" data-add="${p.id}" ${disableAdd ? 'disabled' : ''}>${addLabel}</button></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('[data-add]').forEach(btn => {
      btn.addEventListener('click', () => addPlayer(Number(btn.dataset.add)));
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- Rendering: Roster ----------
  function renderRoster() {
    const container = document.getElementById('roster-groups');
    container.innerHTML = '';
    const counts = filledCounts();

    ROLES.forEach(role => {
      const group = document.createElement('div');
      group.className = 'roster-group';

      const header = document.createElement('div');
      header.className = 'roster-group-header';
      header.innerHTML = `
        <span class="role-tag role-${role}">${role}</span>
        <span class="roster-group-title">${ROLE_LABELS_PLURAL[role]}</span>
        <span class="roster-group-count">${counts[role]}/${SLOTS_PER_ROLE[role]}</span>
      `;
      group.appendChild(header);

      const list = document.createElement('div');
      list.className = 'roster-list';

      const entries = roster
        .map(r => ({ ...r, player: playersById.get(r.id) }))
        .filter(r => r.player && r.player.r === role)
        .sort((a, b) => (b.pricePaid || 0) - (a.pricePaid || 0));

      entries.forEach(entry => {
        const card = document.createElement('div');
        card.className = 'roster-card';
        const starterKey = (entry.player.n.trim() + '|' + entry.player.s.trim()).toLowerCase();
        const isStarter = activeStartersMap()[starterKey];
        const starterBadge = isStarter
          ? `<span class="roster-starter-badge starter-yes" title="${escapeHtml(startersTitle())}">● Titolare</span>`
          : `<span class="roster-starter-badge starter-no" title="Non risulta tra i probabili titolari salvati">○ Non titolare</span>`;
        card.innerHTML = `
          <div class="roster-card-info">
            <div class="roster-card-name">${escapeHtml(entry.player.n)}${entry.synced ? '<span class="synced-badge" title="Aggiunto automaticamente da Asta Live">Sync</span>' : ''}</div>
            <div class="roster-card-team">${escapeHtml(entry.player.s)} ${starterBadge}</div>
          </div>
          <div class="roster-card-actions">
            <input type="number" class="price-input" min="0" step="1" value="${entry.pricePaid}" data-price-id="${entry.id}">
            <button class="btn btn-remove" data-remove="${entry.id}" title="Rimuovi dalla rosa">✕</button>
          </div>
        `;
        list.appendChild(card);
      });

      const emptyCount = SLOTS_PER_ROLE[role] - entries.length;
      for (let i = 0; i < emptyCount; i++) {
        const empty = document.createElement('div');
        empty.className = 'roster-empty-slot';
        empty.textContent = 'Slot libero';
        list.appendChild(empty);
      }

      group.appendChild(list);
      container.appendChild(group);
    });

    container.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', () => removePlayer(Number(btn.dataset.remove)));
    });

    container.querySelectorAll('[data-price-id]').forEach(input => {
      // "input" aggiorna il budget rimanente MENTRE si scrive, senza aspettare che il campo
      // perda il focus: tocca solo le cifre in alto (renderDashboard/renderRoleSpendStrip),
      // mai renderRoster/renderAll, altrimenti l'input verrebbe ricreato e perderebbe il focus
      // a metà digitazione. Il salvataggio vero e proprio (validazione + localStorage) resta
      // sul "change", invariato: qui è solo un'anteprima immediata, non una conferma.
      input.addEventListener('input', () => {
        const id = Number(input.dataset.priceId);
        const entry = roster.find(r => r.id === id);
        if (!entry) return;
        entry.pricePaid = Math.max(0, Math.round(Number(input.value) || 0));
        renderDashboard();
        renderRoleSpendStrip();
      });

      input.addEventListener('change', () => {
        const id = Number(input.dataset.priceId);
        const newPrice = Math.max(0, Math.round(Number(input.value) || 0));
        const check = canSetPrice(id, newPrice);
        if (!check.ok) {
          showToast(check.reason, 'error');
          input.classList.add('over-budget');
        } else {
          input.classList.remove('over-budget');
        }
        setPrice(id, newPrice);
      });
    });
  }

  // ---------- Archivio formazioni salvate + esportazione PDF ----------
  // Le formazioni salvate sono "fotografie" indipendenti (nome/squadra/ruolo/prezzo pagato,
  // non gli Id del listone): restano intatte anche se poi si svuota la rosa o si ricarica un
  // listone diverso. L'export PDF usa la stampa nativa del browser (nessuna libreria nuova):
  // si popola un contenitore dedicato e nascosto, poi window.print() — su desktop il dialogo
  // di stampa permette "Salva come PDF", su iOS Safari lo stesso via Condividi > Stampa.

  function nextFormationId() {
    let id = Date.now();
    while (savedFormations.some(f => f.id === id)) id++;
    return id;
  }

  function totalSpesoEntries(entries) {
    return entries.reduce((sum, e) => sum + (Number(e.pricePaid) || 0), 0);
  }

  async function saveCurrentFormation() {
    if (roster.length === 0) {
      showToast('La rosa è vuota: aggiungi almeno un giocatore prima di salvare.', 'error');
      return;
    }
    const entries = roster.map(r => {
      const p = playersById.get(r.id);
      return p ? { n: p.n, s: p.s, r: p.r, pricePaid: Number(r.pricePaid) || 0 } : null;
    }).filter(Boolean);

    const now = new Date();
    const name = `Formazione ${now.toLocaleDateString('it-IT')} ${now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;
    savedFormations.push({ id: nextFormationId(), name, savedAt: now.toISOString(), budgetTotale: settings.budgetTotale, entries });
    saveState();
    renderFormationsArchive();
    showToast(`Formazione salvata nell'archivio: "${name}".`);
  }

  function startRenameFormation(id, el) {
    const f = savedFormations.find(x => x.id === id);
    if (!f) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = f.name;
    input.className = 'mono-input formation-name-input';
    input.setAttribute('aria-label', 'Rinomina formazione');
    el.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const newName = input.value.trim();
      if (newName) f.name = newName;
      saveState();
      renderFormationsArchive();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { committed = true; renderFormationsArchive(); }
    });
  }

  async function deleteFormation(id) {
    const f = savedFormations.find(x => x.id === id);
    if (!f) return;
    if (!(await showConfirm(`Eliminare la formazione "${f.name}"? Non si può annullare.`))) return;
    savedFormations = savedFormations.filter(x => x.id !== id);
    saveState();
    renderFormationsArchive();
    showToast('Formazione eliminata dall\'archivio.');
  }

  function buildPrintFormationHtml(name, savedAtIso, entries, budgetTotale) {
    const grouped = { P: [], D: [], C: [], A: [] };
    entries.forEach(e => { if (grouped[e.r]) grouped[e.r].push(e); });
    ROLES.forEach(role => grouped[role].sort((a, b) => (b.pricePaid || 0) - (a.pricePaid || 0)));

    const totalSpeso = totalSpesoEntries(entries);
    const dateLabel = new Date(savedAtIso).toLocaleString('it-IT');

    const roleSection = role => `
      <div class="print-role-group">
        <h3>${ROLE_LABELS_PLURAL[role]} <span>(${grouped[role].length})</span></h3>
        <table>
          <thead><tr><th>Nome</th><th>Squadra</th><th>Prezzo</th></tr></thead>
          <tbody>
            ${grouped[role].map(e => `<tr><td>${escapeHtml(e.n)}</td><td>${escapeHtml(e.s)}</td><td>${e.pricePaid || 0} FM</td></tr>`).join('')
              || '<tr><td colspan="3">Nessun giocatore</td></tr>'}
          </tbody>
        </table>
      </div>`;

    return `
      <div class="print-header">
        <div class="print-brand">FANTAASTA Planner</div>
        <h1>${escapeHtml(name)}</h1>
        <p>Salvata il ${dateLabel} &middot; Budget totale ${budgetTotale} FM &middot; Speso ${totalSpeso} FM &middot; ${entries.length}/${TOTAL_SLOTS} giocatori</p>
      </div>
      ${ROLES.map(roleSection).join('')}
    `;
  }

  function exportFormationPdf(id) {
    let name, savedAtIso, entries, budgetTotale;
    if (id === 'current') {
      if (roster.length === 0) {
        showToast('La rosa è vuota: niente da esportare.', 'error');
        return;
      }
      name = 'La mia rosa (attuale)';
      savedAtIso = new Date().toISOString();
      budgetTotale = settings.budgetTotale;
      entries = roster.map(r => {
        const p = playersById.get(r.id);
        return p ? { n: p.n, s: p.s, r: p.r, pricePaid: Number(r.pricePaid) || 0 } : null;
      }).filter(Boolean);
    } else {
      const f = savedFormations.find(x => x.id === id);
      if (!f) return;
      ({ name, entries, budgetTotale } = f);
      savedAtIso = f.savedAt;
    }
    document.getElementById('print-formation').innerHTML = buildPrintFormationHtml(name, savedAtIso, entries, budgetTotale);
    window.print();
  }

  function renderFormationsArchive() {
    const listEl = document.getElementById('formations-list');
    const emptyEl = document.getElementById('formations-empty-state');
    if (!listEl || !emptyEl) return;
    emptyEl.hidden = savedFormations.length > 0;

    listEl.innerHTML = savedFormations
      .slice()
      .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
      .map(f => `
        <div class="formation-card">
          <div class="formation-card-header">
            <span class="formation-name" data-edit-name="${f.id}" title="Clicca per rinominare">${escapeHtml(f.name)}</span>
          </div>
          <div class="formation-card-meta">${new Date(f.savedAt).toLocaleString('it-IT')} &middot; ${f.entries.length}/${TOTAL_SLOTS} giocatori &middot; ${totalSpesoEntries(f.entries)} FM spesi</div>
          <div class="formation-card-actions">
            <button type="button" class="btn" data-export-formation="${f.id}">Esporta PDF</button>
            <button type="button" class="btn btn-remove" data-delete-formation="${f.id}">Elimina</button>
          </div>
        </div>
      `).join('');
  }

  function wireFormationsArchive() {
    document.getElementById('btn-save-formation').addEventListener('click', saveCurrentFormation);
    document.getElementById('btn-export-current-pdf').addEventListener('click', () => exportFormationPdf('current'));

    document.getElementById('formations-list').addEventListener('click', e => {
      const nameEl = e.target.closest('[data-edit-name]');
      if (nameEl) { startRenameFormation(Number(nameEl.dataset.editName), nameEl); return; }
      const exportBtn = e.target.closest('[data-export-formation]');
      if (exportBtn) { exportFormationPdf(Number(exportBtn.dataset.exportFormation)); return; }
      const delBtn = e.target.closest('[data-delete-formation]');
      if (delBtn) { deleteFormation(Number(delBtn.dataset.deleteFormation)); return; }
    });
  }

  // ---------- Full render ----------
  function renderAll() {
    document.body.classList.toggle('no-players', PLAYERS_DATA.length === 0);
    renderImportStatus();
    renderStatsImportStatus();
    renderDashboard();
    renderSettings();
    renderTable();
    renderRoster();
    renderFormationsArchive();
    renderSyncPanel();
    renderTitolariImportStatus();
    renderTitolariReview();
    renderTitolariBrowse();
  }

  function renderImportStatus() {
    const el = document.getElementById('import-status');
    const clearBtn = document.getElementById('btn-clear-players');
    if (PLAYERS_DATA.length === 0) {
      el.textContent = 'Nessun listone caricato.';
      el.classList.remove('loaded');
      clearBtn.disabled = true;
      return;
    }
    const counts = { P: 0, D: 0, C: 0, A: 0 };
    PLAYERS_DATA.forEach(p => { if (counts[p.r] !== undefined) counts[p.r]++; });
    const when = playersMeta && playersMeta.importedAt ? new Date(playersMeta.importedAt).toLocaleString('it-IT') : '';
    const name = playersMeta && playersMeta.fileName ? playersMeta.fileName : 'listone';
    el.textContent = `${name}: ${PLAYERS_DATA.length} giocatori (${counts.P}P/${counts.D}D/${counts.C}C/${counts.A}A)${when ? ' · caricato ' + when : ''}`;
    el.classList.add('loaded');
    clearBtn.disabled = false;
  }

  // ---------- Import listone da Excel/CSV ----------
  // Alias delle intestazioni riconosciute (normalizzate: minuscolo, senza spazi/punteggiatura).
  // "Qt.A"->"qta" e "FVM"->"fvm" sono distinti da "Qt.A M"/"FVM M" (varianti Mantra, ignorate).
  const HEADER_ALIASES = {
    id: ['id'],
    r: ['r', 'ruolo', 'ruoloclassic'],
    n: ['nome', 'giocatore', 'calciatore'],
    s: ['squadra', 'team'],
    qa: ['qta', 'quotazione', 'quotazioneattuale', 'prezzo'],
    fvm: ['fvm', 'fantavalore', 'fantavaloredimercato']
  };

  function normalizeHeader(cell) {
    return String(cell == null ? '' : cell).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function findHeaderRow(aoa) {
    const limit = Math.min(aoa.length, 15);
    for (let i = 0; i < limit; i++) {
      const normCells = (aoa[i] || []).map(normalizeHeader);
      const hasNome = normCells.some(c => HEADER_ALIASES.n.includes(c));
      const hasSquadra = normCells.some(c => HEADER_ALIASES.s.includes(c));
      const hasRuolo = normCells.some(c => HEADER_ALIASES.r.includes(c));
      if (hasNome && hasSquadra && hasRuolo) return i;
    }
    return -1;
  }

  function buildColumnMap(headerRow) {
    const normCells = headerRow.map(normalizeHeader);
    const map = {};
    Object.keys(HEADER_ALIASES).forEach(field => {
      const idx = normCells.findIndex(c => HEADER_ALIASES[field].includes(c));
      if (idx !== -1) map[field] = idx;
    });
    return map;
  }

  // Regola off-limits (SPEC.md): i 5 giocatori per quotazione più alta in ciascun reparto di
  // movimento (D, C, A — non i portieri) non sono acquistabili. Va sempre ricalcolata sul
  // listone effettivamente caricato, non presa per buona da una colonna esterna.
  function recomputeExclFlags(players) {
    ['D', 'C', 'A'].forEach(role => {
      const top5Qa = players
        .filter(p => p.r === role)
        .map(p => p.qa)
        .sort((a, b) => b - a)
        .slice(0, 5);
      const threshold = top5Qa.length ? Math.min(...top5Qa) : Infinity;
      players.forEach(p => {
        if (p.r === role && p.qa >= threshold && top5Qa.length) p.excl = true;
      });
    });
    return players;
  }

  function pickSheet(workbook) {
    const wantedName = workbook.SheetNames.find(n => normalizeHeader(n) === 'tutti');
    return workbook.Sheets[wantedName || workbook.SheetNames[0]];
  }

  function parsePlayersFromAOA(aoa) {
    const headerIdx = findHeaderRow(aoa);
    if (headerIdx === -1) {
      throw new Error('Non trovo le colonne attese (Nome, Squadra, Ruolo) nelle prime righe del file. Controlla il formato.');
    }
    const colMap = buildColumnMap(aoa[headerIdx]);
    if (colMap.n === undefined || colMap.s === undefined || colMap.r === undefined) {
      throw new Error('Colonne obbligatorie mancanti (Nome, Squadra, Ruolo).');
    }

    const players = [];
    const usedIds = new Set();
    let syntheticId = 1;
    let skipped = 0;

    for (let i = headerIdx + 1; i < aoa.length; i++) {
      const row = aoa[i];
      if (!row || row.length === 0) continue;
      const nome = row[colMap.n] != null ? String(row[colMap.n]).trim() : '';
      const squadra = row[colMap.s] != null ? String(row[colMap.s]).trim() : '';
      const ruolo = row[colMap.r] != null ? String(row[colMap.r]).trim().toUpperCase() : '';
      if (!nome || !squadra || !ROLES.includes(ruolo)) { if (nome || squadra) skipped++; continue; }

      const qa = colMap.qa !== undefined ? Number(row[colMap.qa]) || 0 : 0;
      const fvm = colMap.fvm !== undefined ? Number(row[colMap.fvm]) || 0 : 0;
      let id = colMap.id !== undefined ? parseInt(row[colMap.id], 10) : NaN;
      if (!Number.isFinite(id) || usedIds.has(id)) {
        while (usedIds.has(syntheticId)) syntheticId++;
        id = syntheticId;
      }
      usedIds.add(id);

      players.push({ id, r: ruolo, n: nome, s: squadra, qa, fvm, excl: false });
    }

    if (players.length === 0) {
      throw new Error('Nessuna riga valida trovata nel file.');
    }

    recomputeExclFlags(players);
    return { players, skipped };
  }

  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Impossibile leggere il file.'));
      reader.readAsArrayBuffer(file);
    });
  }

  async function handleFileImport(file) {
    let players, skipped;
    try {
      const buffer = await readFileAsArrayBuffer(file);
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = pickSheet(workbook);
      const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
      ({ players, skipped } = parsePlayersFromAOA(aoa));
    } catch (err) {
      showToast(`Import fallito: ${err.message || err}`, 'error');
      return;
    }

    const hasExisting = PLAYERS_DATA.length > 0;
    const hasRoster = roster.length > 0;
    if (hasExisting || hasRoster) {
      const msg = hasRoster
        ? `Caricare questo file sostituirà il listone attuale e azzererà la rosa (${roster.length} giocatori già inseriti). Continuare?`
        : 'Caricare questo file sostituirà il listone attualmente caricato. Continuare?';
      if (!(await showConfirm(msg))) return;
    }

    PLAYERS_DATA = players;
    roster = [];
    playersMeta = { fileName: file.name, importedAt: new Date().toISOString() };
    rebuildDerivedIndexes();
    activeRole = 'P';
    document.querySelectorAll('.role-tab').forEach(t => t.classList.toggle('active', t.dataset.role === 'P'));
    searchTerm = '';
    document.getElementById('search-input').value = '';
    saveState();
    renderAll();

    const counts = { P: 0, D: 0, C: 0, A: 0 };
    players.forEach(p => counts[p.r]++);
    const skippedMsg = skipped > 0 ? ` (${skipped} righe ignorate)` : '';
    showToast(`Listone caricato: ${players.length} giocatori — ${counts.P}P/${counts.D}D/${counts.C}C/${counts.A}A${skippedMsg}.`);
  }

  async function clearPlayers() {
    if (PLAYERS_DATA.length === 0) return;
    const msg = roster.length > 0
      ? `Svuotare il listone caricato azzererà anche la rosa (${roster.length} giocatori già inseriti). Continuare?`
      : 'Svuotare il listone caricato?';
    if (!(await showConfirm(msg))) return;
    PLAYERS_DATA = [];
    roster = [];
    playersMeta = null;
    rebuildDerivedIndexes();
    saveState();
    renderAll();
    showToast('Listone svuotato.');
  }

  function wireImport() {
    document.getElementById('players-file-input').addEventListener('change', e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = ''; // permette di ricaricare lo stesso file una seconda volta
      if (file) handleFileImport(file);
    });
    document.getElementById('btn-clear-players').addEventListener('click', clearPlayers);
  }

  // ---------- Import statistiche reali da Excel/CSV (opzionale) ----------
  // Stesso pattern del listone: file "Statistiche Fantacalcio" ufficiale, foglio "Tutti" se
  // presente, riga di intestazione cercata nelle prime righe. Import indipendente: se manca,
  // il resto dell'app funziona come prima (solo senza le colonne Media/Rendimento).
  const STATS_HEADER_ALIASES = {
    id: ['id'],
    n: ['nome', 'giocatore', 'calciatore'],
    s: ['squadra', 'team'],
    pv: ['pv', 'presenze'],
    mv: ['mv', 'mediavoto'],
    fm: ['fm', 'fantamedia'],
    gf: ['gf', 'golfatti'],
    gs: ['gs', 'golsubiti'],
    ass: ['ass', 'assist'],
    amm: ['amm', 'ammonizioni'],
    esp: ['esp', 'espulsioni'],
    rp: ['rp', 'rigoriparati'],
    au: ['au', 'autogol']
  };

  function findStatsHeaderRow(aoa) {
    const limit = Math.min(aoa.length, 15);
    for (let i = 0; i < limit; i++) {
      const normCells = (aoa[i] || []).map(normalizeHeader);
      const hasNome = normCells.some(c => STATS_HEADER_ALIASES.n.includes(c));
      const hasSquadra = normCells.some(c => STATS_HEADER_ALIASES.s.includes(c));
      const hasMv = normCells.some(c => STATS_HEADER_ALIASES.mv.includes(c));
      if (hasNome && hasSquadra && hasMv) return i;
    }
    return -1;
  }

  function buildStatsColumnMap(headerRow) {
    const normCells = headerRow.map(normalizeHeader);
    const map = {};
    Object.keys(STATS_HEADER_ALIASES).forEach(field => {
      const idx = normCells.findIndex(c => STATS_HEADER_ALIASES[field].includes(c));
      if (idx !== -1) map[field] = idx;
    });
    return map;
  }

  function parseStatsFromAOA(aoa) {
    const headerIdx = findStatsHeaderRow(aoa);
    if (headerIdx === -1) {
      throw new Error('Non trovo le colonne attese (Nome, Squadra, Mv) nelle prime righe del file. Controlla il formato.');
    }
    const colMap = buildStatsColumnMap(aoa[headerIdx]);
    if (colMap.n === undefined || colMap.s === undefined || colMap.mv === undefined) {
      throw new Error('Colonne obbligatorie mancanti (Nome, Squadra, Mv).');
    }

    const num = (row, key) => (colMap[key] !== undefined ? Number(row[colMap[key]]) || 0 : 0);
    const stats = [];
    let skipped = 0;

    for (let i = headerIdx + 1; i < aoa.length; i++) {
      const row = aoa[i];
      if (!row || row.length === 0) continue;
      const nome = row[colMap.n] != null ? String(row[colMap.n]).trim() : '';
      const squadra = row[colMap.s] != null ? String(row[colMap.s]).trim() : '';
      if (!nome || !squadra) { if (nome || squadra) skipped++; continue; }

      const id = colMap.id !== undefined ? parseInt(row[colMap.id], 10) : NaN;
      stats.push({
        id: Number.isFinite(id) ? id : null,
        n: nome, s: squadra,
        pv: num(row, 'pv'), mv: num(row, 'mv'), fm: num(row, 'fm'),
        gf: num(row, 'gf'), gs: num(row, 'gs'), ass: num(row, 'ass'),
        amm: num(row, 'amm'), esp: num(row, 'esp'), rp: num(row, 'rp'), au: num(row, 'au')
      });
    }

    if (stats.length === 0) {
      throw new Error('Nessuna riga valida trovata nel file.');
    }
    return { stats, skipped };
  }

  async function handleStatsFileImport(file) {
    let stats, skipped;
    try {
      const buffer = await readFileAsArrayBuffer(file);
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = pickSheet(workbook);
      const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
      ({ stats, skipped } = parseStatsFromAOA(aoa));
    } catch (err) {
      showToast(`Import statistiche fallito: ${err.message || err}`, 'error');
      return;
    }

    if (STATS_DATA.length > 0) {
      if (!(await showConfirm('Caricare questo file sostituirà le statistiche attualmente caricate. Continuare?'))) return;
    }

    STATS_DATA = stats;
    statsMeta = { fileName: file.name, importedAt: new Date().toISOString() };
    rebuildDerivedIndexes();
    // "Focus automatico" su chi rende di più (media voto + gol/assist, cartellini già pesati
    // poco nella Fantamedia ufficiale) appena le statistiche diventano disponibili.
    sortKey = 'fm';
    sortDir = 'desc';
    saveState();
    renderAll();

    const matched = PLAYERS_DATA.filter(p => statsForPlayer(p) !== null).length;
    const skippedMsg = skipped > 0 ? ` (${skipped} righe ignorate)` : '';
    showToast(`Statistiche caricate: ${stats.length} giocatori, ${matched} abbinati al listone${skippedMsg}.`);
  }

  async function clearStats() {
    if (STATS_DATA.length === 0) return;
    if (!(await showConfirm('Svuotare le statistiche caricate? Le colonne Media/Rendimento spariranno dal Listone.'))) return;
    STATS_DATA = [];
    statsMeta = null;
    rebuildDerivedIndexes();
    saveState();
    renderAll();
    showToast('Statistiche svuotate.');
  }

  function renderStatsImportStatus() {
    const el = document.getElementById('stats-import-status');
    const clearBtn = document.getElementById('btn-clear-stats');
    if (STATS_DATA.length === 0) {
      el.textContent = 'Statistiche non caricate: le colonne Media e Rendimento non sono disponibili, resta solo la Convenienza (FVM/quotazione).';
      el.classList.remove('loaded');
      clearBtn.disabled = true;
      return;
    }
    const matched = PLAYERS_DATA.filter(p => statsForPlayer(p) !== null).length;
    const when = statsMeta && statsMeta.importedAt ? new Date(statsMeta.importedAt).toLocaleString('it-IT') : '';
    el.textContent = `${statsMeta ? statsMeta.fileName : ''}: ${STATS_DATA.length} giocatori, ${matched} abbinati al listone${when ? ' · caricato ' + when : ''}.`;
    el.classList.add('loaded');
    clearBtn.disabled = false;
  }

  function wireStatsImport() {
    document.getElementById('stats-file-input').addEventListener('change', e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) handleStatsFileImport(file);
    });
    document.getElementById('btn-clear-stats').addEventListener('click', clearStats);
  }

  // ---------- Event wiring ----------
  function wireEvents() {
    document.getElementById('input-budget').addEventListener('change', e => {
      const v = Math.max(1, Math.round(Number(e.target.value) || DEFAULT_SETTINGS.budgetTotale));
      settings.budgetTotale = v;
      saveState();
      renderAll();
    });

    document.getElementById('input-teams').addEventListener('change', e => {
      const v = Math.max(2, Math.round(Number(e.target.value) || DEFAULT_SETTINGS.numeroSquadre));
      settings.numeroSquadre = v;
      saveState();
      renderAll();
    });

    document.getElementById('input-correzione').addEventListener('change', e => {
      const v = Math.max(1, Number(e.target.value) || DEFAULT_SETTINGS.correzionePct);
      settings.correzionePct = v;
      saveState();
      renderAll();
    });

    ROLES.forEach(role => {
      document.getElementById(`pct-${role}`).addEventListener('change', e => {
        const v = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
        const trial = { ...settings.pct, [role]: v };
        settings.pct = trial;
        saveState();
        renderSettings();
        renderTable();
      });
    });

    document.getElementById('preset-row').addEventListener('click', e => {
      const btn = e.target.closest('.preset-btn');
      if (!btn) return;
      const preset = PCT_PRESETS.find(p => p.key === btn.dataset.preset);
      if (!preset) return;
      settings.pct = { ...preset.pct };
      saveState();
      renderSettings();
      renderTable();
      showToast(`Percentuali applicate: P ${preset.pct.P}% · D ${preset.pct.D}% · C ${preset.pct.C}% · A ${preset.pct.A}%`);
    });

    document.getElementById('role-tabs').addEventListener('click', e => {
      const btn = e.target.closest('.role-tab');
      if (!btn) return;
      activeRole = btn.dataset.role;
      document.querySelectorAll('.role-tab').forEach(t => t.classList.toggle('active', t === btn));
      renderTable();
    });

    document.getElementById('search-input').addEventListener('input', e => {
      searchTerm = e.target.value;
      renderTable();
    });

    document.getElementById('hide-sold-toggle').addEventListener('change', e => {
      hideSold = e.target.checked;
      renderTable();
    });

    document.querySelectorAll('#players-table th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (sortKey === key) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortKey = key;
          sortDir = 'desc';
        }
        renderTable();
      });
    });
  }

  // ---------- Sincronizzazione con Asta Live Fantacalcio ----------
  // Matching tra le due app: Asta Live non condivide gli Id del listone ufficiale, quindi i
  // giocatori si abbinano per nome+squadra normalizzati (stesso approccio di starters.js).
  function normalizeMatchKey(name, team) {
    return (String(name || '').trim() + '|' + String(team || '').trim()).toLowerCase();
  }

  // Id stabile e negativo (mai in conflitto con gli id, sempre positivi, del listone importato)
  // per i giocatori sincronizzati da Asta Live che non trovano corrispondenza nel listone caricato.
  function stableSyntheticId(key) {
    let hash = 5381;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
    }
    return -Math.abs(hash) - 1;
  }

  // Inserisce/aggiorna nella rosa un giocatore risultato acquistato su Asta Live. Ignora il
  // controllo budget/slot "morbido" usato per i giocatori aggiunti a mano: un acquisto reale in
  // asta va sempre riflesso in rosa. Ritorna true se ha effettivamente aggiunto o aggiornato.
  function addSyncedPlayer(role, name, realTeam, finalPrice) {
    const key = normalizeMatchKey(name, realTeam);
    if (sync.ignoreKeys.includes(key)) return false;

    let player = matchIndexByKey.get(key);
    if (!player) {
      const id = stableSyntheticId(key);
      player = playersById.get(id);
      if (!player) {
        player = { id, r: role, n: name, s: realTeam, qa: 0, fvm: 0, excl: false, synced: true };
        PLAYERS_DATA.push(player);
        playersById.set(id, player);
        matchIndexByKey.set(key, player);
      }
    }

    const existing = roster.find(r => r.id === player.id);
    if (existing) {
      if (existing.pricePaid !== finalPrice || !existing.synced) {
        existing.pricePaid = finalPrice;
        existing.synced = true;
        return true;
      }
      return false;
    }
    roster.push({ id: player.id, pricePaid: finalPrice, synced: true });
    return true;
  }

  function syncBaseUrl() {
    return (sync.baseUrl || DEFAULT_SYNC.baseUrl).trim().replace(/\/+$/, '');
  }

  let syncTimer = null;
  let syncTickInFlight = false;

  function stopPolling() {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    stopRoomSoldPolling();
  }

  function startPolling() {
    stopPolling();
    if (!sync.teamId) return;
    syncTick();
    syncTimer = setInterval(syncTick, SYNC_POLL_INTERVAL_MS);
    startRoomSoldPolling();
  }

  async function syncTick() {
    if (!sync.roomCode || !sync.teamId || syncTickInFlight) return;
    syncTickInFlight = true;
    try {
      const url = `${syncBaseUrl()}/api/rooms/${encodeURIComponent(sync.roomCode)}/sync/roster?participantId=${encodeURIComponent(sync.teamId)}`;
      const res = await fetch(url);
      if (res.status === 403 || res.status === 404) {
        stopPolling();
        sync.lastError = res.status === 403
          ? 'La sincronizzazione per questa squadra è stata disattivata dall’admin della stanza.'
          : 'Stanza non trovata: controlla il codice o scollega e ricollega.';
        saveState();
        renderSyncPanel();
        return;
      }
      if (!res.ok) throw new Error('Risposta non valida dal server.');
      const data = await res.json();
      sync.teamName = data.teamName || sync.teamName;
      sync.lastError = null;
      sync.lastSyncedAt = new Date().toISOString();

      let added = 0;
      (data.players || []).forEach(p => {
        if (addSyncedPlayer(p.role, p.name, p.realTeam, p.finalPrice)) added++;
      });

      saveState();
      if (added > 0) {
        rebuildDerivedIndexes();
        renderAll();
        showToast(`${added} giocatore${added === 1 ? '' : 'i'} sincronizzat${added === 1 ? 'o' : 'i'} da Asta Live.`);
      } else {
        renderSyncPanel();
      }
    } catch (err) {
      sync.lastError = 'Impossibile contattare Asta Live (verifica connessione o indirizzo).';
      saveState();
      renderSyncPanel();
    } finally {
      syncTickInFlight = false;
    }
  }

  // ---- Disponibilità dell'intero listone: chi è già stato acquistato da QUALSIASI squadra
  // della stanza (non solo la propria), per nascondere/segnare quei giocatori nel Listone. Un
  // giro interroga il roster di ogni squadra della stanza: se l'admin non ha attivato la
  // sincronizzazione per una squadra, quella specifica richiesta risponde 403/404 e viene
  // saltata (non blocca le altre) — il conteggio "squadre sincronizzate" in UI riflette quante
  // hanno risposto, così si capisce subito se mancano attivazioni.
  let roomSoldTimer = null;
  let roomSoldTickInFlight = false;

  function stopRoomSoldPolling() {
    if (roomSoldTimer) {
      clearInterval(roomSoldTimer);
      roomSoldTimer = null;
    }
  }

  function startRoomSoldPolling() {
    stopRoomSoldPolling();
    if (!sync.roomCode) return;
    roomSoldTick();
    roomSoldTimer = setInterval(roomSoldTick, ROOM_SOLD_POLL_INTERVAL_MS);
  }

  async function roomSoldTick() {
    if (!sync.roomCode || roomSoldTickInFlight) return;
    roomSoldTickInFlight = true;
    try {
      const teamsRes = await fetch(`${syncBaseUrl()}/api/rooms/${encodeURIComponent(sync.roomCode)}/sync/teams`);
      if (!teamsRes.ok) return;
      const teamsData = await teamsRes.json();
      const teams = teamsData.teams || [];

      const soldByTeam = {};
      let okCount = 0;

      await Promise.all(teams.map(async t => {
        try {
          const res = await fetch(`${syncBaseUrl()}/api/rooms/${encodeURIComponent(sync.roomCode)}/sync/roster?participantId=${encodeURIComponent(t.id)}`);
          if (!res.ok) return; // 403/404: sync non attiva per questa squadra, si salta senza bloccare le altre
          const data = await res.json();
          okCount++;
          const teamLabel = data.teamName || t.name || 'altra squadra';
          (data.players || []).forEach(p => {
            soldByTeam[normalizeMatchKey(p.name, p.realTeam)] = teamLabel;
          });
        } catch (e) { /* rete assente per questa squadra, si riprova al prossimo giro */ }
      }));

      sync.soldByTeam = soldByTeam;
      sync.soldTeamsOk = okCount;
      sync.soldTeamsTotal = teams.length;
      sync.soldLastSyncedAt = new Date().toISOString();
      saveState();
      renderTable();
    } catch (e) {
      // stanza/rete irraggiungibile: si riprova al prossimo giro, nessun errore bloccante
      // (a differenza del poll della propria rosa, qui non è critico perdere un ciclo)
    } finally {
      roomSoldTickInFlight = false;
    }
  }

  // true se il giocatore risulta acquistato da un'ALTRA squadra della stanza (non la propria:
  // quelli restano gestiti dal flusso "La mia rosa" esistente, niente doppia etichetta).
  function isSoldElsewhere(p) {
    if (!sync.soldByTeam) return false;
    const team = sync.soldByTeam[normalizeMatchKey(p.n, p.s)];
    if (!team) return false;
    return !roster.some(r => r.id === p.id);
  }

  async function findSyncTeams() {
    const baseUrl = document.getElementById('sync-base-url').value.trim().replace(/\/+$/, '') || DEFAULT_SYNC.baseUrl;
    const roomCode = document.getElementById('sync-room-code').value.trim().toUpperCase();
    const msgEl = document.getElementById('sync-setup-msg');
    const picker = document.getElementById('sync-teams-picker');
    const select = document.getElementById('sync-team-select');
    msgEl.textContent = '';
    picker.hidden = true;

    if (!roomCode) {
      msgEl.textContent = 'Inserisci il codice stanza di Asta Live.';
      return;
    }

    try {
      const res = await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(roomCode)}/sync/teams`);
      if (res.status === 404) {
        msgEl.textContent = 'Codice stanza non trovato su Asta Live.';
        return;
      }
      if (!res.ok) throw new Error('Risposta non valida.');
      const data = await res.json();
      const teams = data.teams || [];
      if (teams.length === 0) {
        msgEl.textContent = 'Nessuna squadra ha la sincronizzazione attiva in questa stanza: chiedi all’admin di attivarla per la tua squadra.';
        return;
      }
      select.innerHTML = teams.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('');
      picker.hidden = false;
      picker.dataset.baseUrl = baseUrl;
      picker.dataset.roomCode = roomCode;
    } catch (err) {
      msgEl.textContent = 'Impossibile contattare Asta Live: verifica indirizzo e connessione.';
    }
  }

  function linkSyncTeam() {
    const picker = document.getElementById('sync-teams-picker');
    const select = document.getElementById('sync-team-select');
    const option = select.options[select.selectedIndex];
    if (!option) return;

    sync.baseUrl = picker.dataset.baseUrl;
    sync.roomCode = picker.dataset.roomCode;
    sync.teamId = option.value;
    sync.teamName = option.textContent;
    sync.lastError = null;
    sync.lastSyncedAt = null;
    saveState();
    renderSyncPanel();
    startPolling();
    showToast(`Squadra "${option.textContent}" collegata. Sincronizzazione avviata.`);
  }

  async function unlinkSyncTeam() {
    if (!(await showConfirm('Scollegare la sincronizzazione con Asta Live? I giocatori già sincronizzati restano nella tua rosa.'))) return;
    stopPolling();
    const baseUrl = sync.baseUrl;
    sync = { ...DEFAULT_SYNC, baseUrl, ignoreKeys: sync.ignoreKeys };
    saveState();
    renderSyncPanel();
  }

  function renderSyncPanel() {
    const linkedEl = document.getElementById('sync-linked');
    const setupEl = document.getElementById('sync-setup');
    const baseUrlInput = document.getElementById('sync-base-url');
    const roomCodeInput = document.getElementById('sync-room-code');

    if (document.activeElement !== baseUrlInput) baseUrlInput.value = sync.baseUrl || DEFAULT_SYNC.baseUrl;
    if (document.activeElement !== roomCodeInput) roomCodeInput.value = sync.roomCode || '';

    const linked = !!sync.teamId;
    linkedEl.hidden = !linked;
    setupEl.hidden = linked;
    if (!linked) return;

    document.getElementById('sync-team-label').textContent = `${sync.teamName || '—'} (stanza ${sync.roomCode})`;
    document.getElementById('sync-last-update').textContent = sync.lastSyncedAt
      ? new Date(sync.lastSyncedAt).toLocaleTimeString('it-IT')
      : 'mai';

    const errEl = document.getElementById('sync-error-msg');
    if (sync.lastError) {
      errEl.textContent = sync.lastError;
      errEl.hidden = false;
    } else {
      errEl.hidden = true;
    }

    const ignoredWrap = document.getElementById('sync-ignored');
    const ignoredList = document.getElementById('sync-ignored-list');
    const keys = sync.ignoreKeys || [];
    ignoredWrap.hidden = keys.length === 0;
    ignoredList.innerHTML = keys.map(key => {
      const [name, team] = key.split('|');
      return `
        <span class="sync-ignored-chip">
          ${escapeHtml(titleCase(name))} <span class="sync-ignored-team">(${escapeHtml(titleCase(team))})</span>
          <button type="button" class="sync-ignored-undo" data-unignore="${escapeHtml(key)}" title="Riattiva la sincronizzazione automatica per questo giocatore">Includi di nuovo</button>
        </span>
      `;
    }).join('');
  }

  function titleCase(str) {
    return String(str || '').replace(/\b\w/g, c => c.toUpperCase());
  }

  function wireSync() {
    document.getElementById('btn-sync-find-teams').addEventListener('click', findSyncTeams);
    document.getElementById('btn-sync-link').addEventListener('click', linkSyncTeam);
    document.getElementById('btn-sync-now').addEventListener('click', () => syncTick());
    document.getElementById('btn-sync-unlink').addEventListener('click', unlinkSyncTeam);
    document.getElementById('sync-ignored-list').addEventListener('click', e => {
      const btn = e.target.closest('[data-unignore]');
      if (btn) unignoreKey(btn.dataset.unignore);
    });

    // Il polling resta sempre attivo mentre una squadra e' collegata: durante un'asta live
    // l'utente tiene spesso questa scheda in background (guarda la stanza dell'asta su
    // un'altra scheda/dispositivo), e fermare il polling quando la pagina non e' in primo
    // piano vuol dire perdere acquisti per minuti interi. In piu' facciamo un refresh
    // immediato non appena la pagina torna visibile, cosi' l'utente vede subito lo stato
    // aggiornato invece di aspettare il prossimo tick.
    document.addEventListener('visibilitychange', () => {
      if (sync.teamId && document.visibilityState === 'visible') syncTick();
    });

    // Se la connessione cade (rete della sede dell'asta, cambio wifi/dati) e poi torna,
    // ricontrolliamo subito invece di aspettare fino a SYNC_POLL_INTERVAL_MS.
    window.addEventListener('online', () => {
      if (sync.teamId) syncTick();
    });
  }

  // ---------- Probabili titolari: import da PDF ----------
  // Il PDF "Infografica" di fantacalcio.it non contiene testo né vettori: ogni pagina è
  // un'unica immagine raster. La pipeline quindi: 1) renderizza ogni pagina su canvas con
  // pdf.js, 2) individua i riquadri squadra cercando righe/colonne quasi-bianche (si adatta
  // al numero di righe/colonne, non è cablato), 3) per ogni riquadro rileva i pallini colorati
  // per ruolo (giallo=P, verde=D, blu=C, rosso=A) via flood-fill sui colori, 4) fa l'OCR
  // (Tesseract.js) del riquadro (esclusa la colonna Ballottaggi/Rigori/Punizioni, non serve e
  // se inclusa confonde l'OCR), 5) raggruppa le parole riconosciute in etichette per prossimità
  // e abbina ciascuna etichetta al pallino più vicino = nome+ruolo, 6) abbina il nome al
  // giocatore del listone (match per prefisso, gestisce troncamenti tipo "Vitinha"→"Vitinha O.").
  // Il risultato passa SEMPRE da una revisione manuale prima di essere salvato (vedi SPEC §6:
  // "nessun dato deve essere inventato") perché l'OCR può perdere etichette in zone affollate
  // del campo o leggere male un nome.

  function activeStartersMap() {
    // Niente fallback su dati statici: il pallino/la vista titolari restano vuoti finché
    // l'utente non importa e conferma un PDF, cosí non si mostra mai un dato potenzialmente
    // vecchio come se fosse affidabile.
    if (titolariImport && Array.isArray(titolariImport.entries) && titolariImport.entries.length) {
      const map = {};
      titolariImport.entries.forEach(e => { map[(String(e.n).trim() + '|' + String(e.s).trim()).toLowerCase()] = true; });
      return map;
    }
    return {};
  }

  function startersTitle() {
    if (titolariImport && titolariImport.meta) {
      const d = new Date(titolariImport.meta.importedAt).toLocaleDateString('it-IT');
      return `Probabile titolare secondo il PDF importato il ${d}`;
    }
    return 'Probabile titolare';
  }

  function normalizeNameForMatch(s) {
    return String(s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // rimuove accenti/diacritici
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function bestNameMatch(ocrText, candidates) {
    const norm = normalizeNameForMatch(ocrText);
    if (!norm) return null;
    const exact = candidates.find(p => normalizeNameForMatch(p.n) === norm);
    if (exact) return exact;
    const prefix = candidates.filter(p => {
      const pn = normalizeNameForMatch(p.n);
      return pn.startsWith(norm) || norm.startsWith(pn);
    });
    return prefix.length === 1 ? prefix[0] : null; // ambiguo (0 o >1): lascia scegliere in revisione
  }

  function matchTeamName(ocrTeam) {
    if (!ocrTeam) return null;
    const norm = normalizeNameForMatch(ocrTeam);
    const known = PLAYERS_DATA.length ? [...new Set(PLAYERS_DATA.map(p => p.s))] : KNOWN_TEAM_NAMES_FALLBACK;
    const exact = known.find(t => normalizeNameForMatch(t) === norm);
    if (exact) return exact;
    // "includes" (non solo prefisso): il nome squadra nell'header a volte prende rumore OCR
    // dallo stemma vicino (es. "BG Lecce" invece di "Lecce").
    const partial = known.filter(t => {
      const tn = normalizeNameForMatch(t);
      return norm.includes(tn) || tn.includes(norm);
    });
    return partial.length === 1 ? partial[0] : null;
  }

  // ---- Rendering pagina PDF e individuazione riquadri squadra ----

  let titolariPdfConfigured = false;
  function ensureTitolariLibsConfigured() {
    if (titolariPdfConfigured) return;
    if (typeof pdfjsLib !== 'undefined') {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    }
    titolariPdfConfigured = true;
  }

  // Trova i blocchi di contenuto lungo un asse (righe o colonne) cercando bande "quasi
  // bianche" (soglia <1% pixel non bianchi) come separatori. Unisce separatori vicini (sotto
  // gli 80px) perché i bordi arrotondati/ombra dei riquadri creano più bande bianche sottili
  // invece di una sola. Scarta blocchi molto più piccoli della mediana (tipicamente la barra
  // del titolo in alto, non un riquadro squadra) invece di assumere un'altezza fissa: così si
  // adatta se il template cambia numero di righe/colonne.
  function findContentBlocks(isWhiteFn, length) {
    const gaps = [];
    let inGap = false, gapStart = 0;
    for (let i = 0; i < length; i++) {
      const w = isWhiteFn(i);
      if (w && !inGap) { inGap = true; gapStart = i; }
      if (!w && inGap) { inGap = false; if (i - gapStart > 3) gaps.push([gapStart, i]); }
    }
    if (inGap && length - gapStart > 3) gaps.push([gapStart, length]);

    const merged = [];
    gaps.forEach(g => {
      if (merged.length && g[0] - merged[merged.length - 1][1] < 80) {
        merged[merged.length - 1][1] = g[1];
      } else {
        merged.push(g.slice());
      }
    });

    const blocks = [];
    let cursor = 0;
    merged.forEach(([gs, ge]) => {
      if (gs - cursor > 20) blocks.push([cursor, gs]);
      cursor = ge;
    });
    if (length - cursor > 20) blocks.push([cursor, length]);

    if (blocks.length <= 1) return blocks;
    const sizes = blocks.map(b => b[1] - b[0]).slice().sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    return blocks.filter(b => (b[1] - b[0]) >= median * 0.5);
  }

  function detectPanelRects(imgData, width, height) {
    const data = imgData.data;
    const isWhitePixelAt = idx => data[idx] > 245 && data[idx + 1] > 245 && data[idx + 2] > 245;

    const isWhiteRow = y => {
      let nonWhite = 0, total = 0;
      for (let x = 0; x < width; x += 4) {
        total++;
        if (!isWhitePixelAt((y * width + x) * 4)) nonWhite++;
      }
      return nonWhite < total * 0.01;
    };
    const rowBlocks = findContentBlocks(isWhiteRow, height);

    const panels = [];
    rowBlocks.forEach(([y0, y1]) => {
      const isWhiteColInRow = x => {
        let nonWhite = 0, total = 0;
        for (let y = y0; y < y1; y += 4) {
          total++;
          if (!isWhitePixelAt((y * width + x) * 4)) nonWhite++;
        }
        return nonWhite < total * 0.01;
      };
      const colBlocks = findContentBlocks(isWhiteColInRow, width);
      colBlocks.forEach(([x0, x1]) => {
        panels.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      });
    });
    return panels;
  }

  function cropCanvas(sourceCanvas, x, y, w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    c.getContext('2d').drawImage(sourceCanvas, x, y, w, h, 0, 0, c.width, c.height);
    return c;
  }

  // ---- Rilevamento pallini ruolo (flood-fill sui colori) ----

  // Soglie calibrate sulla palette dell'infografica fantacalcio.it (giallo/ambra portieri,
  // verde difensori, blu centrocampisti, rosso attaccanti).
  function classifyRoleColor(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min < 20) return null; // grigio/bianco/nero: non è un pallino
    if (r > 200 && g > 130 && g < 200 && b < 100) return 'P';
    if (g > 120 && r < 120 && b < 120) return 'D';
    if (b > 150 && r < 120 && g < 170) return 'C';
    if (r > 170 && g < 90 && b < 90) return 'A';
    return null;
  }

  // excludeTopFrac esclude l'area di stemma/titolo squadra in alto nel riquadro: ha colori
  // simili ai pallini e senza esclusione produce falsi positivi.
  function detectRoleDots(canvas, excludeTopFrac) {
    const width = canvas.width, height = canvas.height;
    const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
    const yStart = Math.round(height * excludeTopFrac);
    const visited = new Uint8Array(width * height);
    const blobs = [];

    for (let y = yStart; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const idx = y * width + x;
        if (visited[idx]) continue;
        const p = idx * 4;
        const role = classifyRoleColor(data[p], data[p + 1], data[p + 2]);
        if (!role) continue;
        const stack = [[x, y]];
        let sx = 0, sy = 0, count = 0;
        while (stack.length) {
          const [cx, cy] = stack.pop();
          if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
          const ci = cy * width + cx;
          if (visited[ci]) continue;
          const cp = ci * 4;
          if (classifyRoleColor(data[cp], data[cp + 1], data[cp + 2]) !== role) continue;
          visited[ci] = 1;
          sx += cx; sy += cy; count++;
          stack.push([cx + 2, cy], [cx - 2, cy], [cx, cy + 2], [cx, cy - 2]);
        }
        if (count > 250) blobs.push({ role, cx: sx / count, cy: sy / count }); // scarta rumore/testo colorato
      }
    }
    return blobs;
  }

  // ---- OCR (Tesseract.js) e clustering parole → etichette nome ----

  let ocrWorkerPromise = null;
  function getOcrWorker() {
    if (!ocrWorkerPromise) {
      ocrWorkerPromise = Tesseract.createWorker('ita', 1, {
        workerPath: 'vendor/tesseract-worker.min.js',
        corePath: 'vendor/tesseract-core-lstm.wasm.js',
        langPath: 'vendor/tessdata/',
        gzip: false,
        cacheMethod: 'none'
      });
    }
    return ocrWorkerPromise;
  }

  async function terminateOcrWorker() {
    if (!ocrWorkerPromise) return;
    const w = await ocrWorkerPromise;
    ocrWorkerPromise = null;
    try { await w.terminate(); } catch (e) { /* worker già chiuso */ }
  }

  async function ocrPanelWords(worker, canvas) {
    const { data } = await worker.recognize(canvas, {}, { tsv: true, text: false });
    const words = [];
    (data.tsv || '').split('\n').forEach(line => {
      const cols = line.split('\t');
      if (cols[0] !== '5') return; // livello 5 = parola
      const text = (cols[11] || '').trim();
      if (!text || !/[A-Za-zÀ-ÖØ-öø-ÿ]{2,}/.test(text)) return; // scarta simboli spuri dei pallini
      words.push({ text, x: +cols[6], y: +cols[7], w: +cols[8], h: +cols[9] });
    });
    return words;
  }

  // Raggruppa le singole parole OCR in etichette per prossimità spaziale (non per "riga"
  // individuata da tesseract: unirebbe erroneamente etichette di giocatori diversi che si
  // trovano sulla stessa riga del campo ma distanti in orizzontale).
  function clusterWordsIntoLabels(words) {
    const sorted = words.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const used = new Array(sorted.length).fill(false);
    const clusters = [];

    for (let i = 0; i < sorted.length; i++) {
      if (used[i]) continue;
      const cluster = [sorted[i]];
      used[i] = true;
      let changed = true;
      while (changed) {
        changed = false;
        for (let j = 0; j < sorted.length; j++) {
          if (used[j]) continue;
          for (const c of cluster) {
            const dx = Math.min(Math.abs(sorted[j].x - (c.x + c.w)), Math.abs((sorted[j].x + sorted[j].w) - c.x));
            const dy = Math.abs(sorted[j].y - c.y);
            if (dx < 60 && dy < 25) {
              cluster.push(sorted[j]);
              used[j] = true;
              changed = true;
              break;
            }
          }
        }
      }
      clusters.push(cluster);
    }

    return clusters.map(c => {
      c.sort((a, b) => a.x - b.x);
      const minX = Math.min(...c.map(w => w.x));
      const maxX = Math.max(...c.map(w => w.x + w.w));
      const minY = Math.min(...c.map(w => w.y));
      const maxY = Math.max(...c.map(w => w.y + w.h));
      return {
        text: c.map(w => w.text).join(' '),
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
        height: Math.max(...c.map(w => w.h))
      };
    });
  }

  // Frazione di larghezza riquadro da tenere (esclude la colonna Ballottaggi/Rigori/Punizioni,
  // che non serve e se inclusa nell'OCR genera testo corrotto per la vicinanza con lo schema
  // campo). Frazione di altezza esclusa in alto (stemma+nome squadra, vedi detectRoleDots).
  const PANEL_PITCH_WIDTH_FRAC = 0.651;
  const PANEL_HEADER_HEIGHT_FRAC = 0.172;

  async function parseTeamPanel(pageCanvas, rect, worker) {
    const cropW = rect.w * PANEL_PITCH_WIDTH_FRAC;
    const panelCanvas = cropCanvas(pageCanvas, rect.x, rect.y, cropW, rect.h);

    const dots = detectRoleDots(panelCanvas, PANEL_HEADER_HEIGHT_FRAC);
    const words = await ocrPanelWords(worker, panelCanvas);
    const labels = clusterWordsIntoLabels(words);

    const headerLabels = labels.filter(l => l.cy < rect.h * PANEL_HEADER_HEIGHT_FRAC);
    const teamNameLabel = headerLabels.slice().sort((a, b) => b.height - a.height)[0];
    const team = teamNameLabel ? teamNameLabel.text.trim() : null;

    const nameLabels = labels.filter(l =>
      l.cy >= rect.h * PANEL_HEADER_HEIGHT_FRAC &&
      !/^\d(-\d)+$/.test(l.text) &&
      !/^all:?/i.test(l.text)
    );

    const matched = nameLabels.map(l => {
      let best = null, bestDist = Infinity;
      dots.forEach(d => {
        const dist = Math.hypot(d.cx - l.cx, d.cy - l.cy);
        if (dist < bestDist) { bestDist = dist; best = d; }
      });
      return best && bestDist < 200 ? { ocrText: l.text, role: best.role } : null;
    }).filter(Boolean);

    return { team, dotsFound: dots.length, matched };
  }

  // ---- Orchestrazione import + progress ----

  function showTitolariProgress(show) {
    document.getElementById('titolari-progress').hidden = !show;
    if (!show) updateTitolariProgress('', 0);
  }

  function updateTitolariProgress(text, pct) {
    document.getElementById('titolari-progress-text').textContent = text;
    document.getElementById('titolari-progress-fill').style.width = `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
  }

  async function handleTitolariPdfImport(file) {
    if (typeof pdfjsLib === 'undefined' || typeof Tesseract === 'undefined') {
      showToast('Librerie PDF/OCR non disponibili: ricarica la pagina e riprova.', 'error');
      return;
    }
    if (PLAYERS_DATA.length === 0) {
      const proceed = await showConfirm('Il listone non è ancora caricato: senza abbinamento ai giocatori i titolari rilevati non potranno essere confermati. Caricare comunque il PDF adesso?');
      if (!proceed) return;
    }

    ensureTitolariLibsConfigured();
    pendingReview = null;
    renderTitolariReview();
    showTitolariProgress(true);
    updateTitolariProgress('Lettura del PDF…', 2);

    try {
      const buffer = await readFileAsArrayBuffer(file);
      const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

      const panelJobs = [];
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        updateTitolariProgress(`Rendering pagina ${pageNum}/${pdf.numPages}…`, 5 + (pageNum - 1) * 10);
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const imgData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        detectPanelRects(imgData, canvas.width, canvas.height).forEach(rect => panelJobs.push({ canvas, rect }));
      }

      if (panelJobs.length === 0) {
        throw new Error('Non ho trovato nessun riquadro squadra nel PDF: il formato potrebbe essere diverso da quello atteso.');
      }

      const worker = await getOcrWorker();
      const panelResults = [];
      for (let i = 0; i < panelJobs.length; i++) {
        updateTitolariProgress(`Analisi squadra ${i + 1}/${panelJobs.length}…`, 25 + (i / panelJobs.length) * 70);
        panelResults.push(await parseTeamPanel(panelJobs[i].canvas, panelJobs[i].rect, worker));
      }

      updateTitolariProgress('Preparazione revisione…', 98);
      buildPendingReview(panelResults);
      pendingReview.fileName = file.name;
      showTitolariProgress(false);
      renderTitolariReview();
      document.getElementById('titolari-review').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      showTitolariProgress(false);
      showToast(`Analisi PDF fallita: ${err.message || err}`, 'error');
    } finally {
      await terminateOcrWorker();
    }
  }

  // ---- Editor titolari per squadra: casella di spunta per ogni giocatore del listone di
  // quella squadra/ruolo, salvataggio squadra-per-squadra (non serve rivedere tutte le 20
  // squadre in un colpo solo, né rifare il PDF per correggere una sola squadra dopo). Stesso
  // componente sia nella revisione post-import (con suggerimenti dall'OCR) sia nella modifica
  // manuale dalla vista "sfoglia" (senza PDF, si spunta direttamente dal listone).

  function renderTeamRoleCheckboxes(team, checkedIds) {
    const groups = ROLES.map(role => {
      const players = PLAYERS_DATA
        .filter(p => p.r === role && normalizeNameForMatch(p.s) === normalizeNameForMatch(team))
        .sort((a, b) => a.n.localeCompare(b.n, 'it'));
      if (players.length === 0) return '';
      return `
        <div class="titolari-role-group">
          <span class="role-tag role-${role}">${role}</span>
          <div class="titolari-checkbox-list">
            ${players.map(p => `
              <label class="titolari-checkbox-item">
                <input type="checkbox" value="${p.id}" ${checkedIds.has(p.id) ? 'checked' : ''}>
                <span>${escapeHtml(p.n)}</span>
              </label>`).join('')}
          </div>
        </div>`;
    }).join('');
    return groups || '<p class="hint">Nessun giocatore di questa squadra nel listone.</p>';
  }

  function collectCheckedIds(container) {
    return new Set([...container.querySelectorAll('.titolari-checkbox-item input:checked')].map(el => +el.value));
  }

  // Sostituisce solo i titolari SALVATI di questa squadra, lasciando intatti quelli delle
  // altre squadre — è quello che rende possibile salvare/correggere una squadra alla volta.
  function upsertTitolariForTeam(team, checkedIds) {
    const otherEntries = (titolariImport ? titolariImport.entries : []).filter(e => normalizeNameForMatch(e.s) !== normalizeNameForMatch(team));
    const newEntries = [...checkedIds].map(id => playersById.get(id)).filter(Boolean).map(p => ({ id: p.id, n: p.n, s: p.s, r: p.r }));
    const entries = otherEntries.concat(newEntries);
    const prevMeta = titolariImport && titolariImport.meta;
    titolariImport = {
      entries,
      meta: {
        updatedAt: new Date().toISOString(),
        fileName: (prevMeta && prevMeta.fileName) || (pendingReview && pendingReview.fileName) || null,
        teamsParsed: new Set(entries.map(e => e.s)).size,
        playersMatched: entries.length
      }
    };
    saveState();
  }

  function refreshAfterTitolariChange() {
    renderTitolariImportStatus();
    renderTable();
    renderRoster();
  }

  // ---- Revisione dopo l'import PDF: una card per squadra, con salvataggio indipendente ----

  let pendingReview = null; // { teams:[{team, suggestedIds:Set, uncertain:[...], collapsed, saved}], stats:{...}, fileName }

  function buildPendingReview(panelResults) {
    const teams = [];
    let playersMatched = 0, playersUnmatched = 0, teamsFailed = 0;

    panelResults.forEach(res => {
      const teamLabel = matchTeamName(res.team) || res.team || 'Squadra non riconosciuta';
      if (!res.team || res.dotsFound === 0) teamsFailed++;

      const suggestedIds = new Set();
      const uncertain = [];
      res.matched.forEach(m => {
        const candidates = PLAYERS_DATA.filter(p => p.r === m.role && normalizeNameForMatch(p.s) === normalizeNameForMatch(teamLabel));
        const auto = bestNameMatch(m.ocrText, candidates);
        if (auto) { suggestedIds.add(auto.id); playersMatched++; }
        else { uncertain.push(m.ocrText); playersUnmatched++; }
      });

      teams.push({ team: teamLabel, suggestedIds, uncertain, collapsed: false, saved: false });
    });

    pendingReview = { teams, stats: { playersMatched, playersUnmatched, teamsParsed: panelResults.length, teamsFailed } };
  }

  function renderReviewTeamCard(t, ti) {
    const uncertainNote = t.uncertain.length
      ? `<p class="hint titolari-uncertain-hint">Rilevati dal PDF ma non abbinati automaticamente: ${t.uncertain.map(escapeHtml).join(', ')} — spunta a mano qui sotto se corrispondono a un titolare.</p>`
      : '';
    return `
      <div class="titolari-team-card${t.collapsed ? ' collapsed' : ''}" data-team-index="${ti}">
        <div class="titolari-team-card-header" data-toggle-team="${ti}">
          <span class="titolari-team-name">${escapeHtml(t.team)}</span>
          <span class="titolari-saved-badge-slot">${t.saved ? '<span class="titolari-saved-badge">✓ Salvata</span>' : ''}</span>
          <span class="titolari-team-toggle">${t.collapsed ? '▸' : '▾'}</span>
        </div>
        <div class="titolari-team-card-body">
          ${uncertainNote}
          ${renderTeamRoleCheckboxes(t.team, t.suggestedIds)}
          <div class="titolari-team-card-actions">
            <button type="button" class="btn btn-add titolari-save-team-btn" data-team="${ti}">Salva squadra</button>
          </div>
        </div>
      </div>`;
  }

  function renderTitolariReview() {
    const wrap = document.getElementById('titolari-review');
    const browseWrap = document.getElementById('titolari-browse');
    if (!pendingReview) {
      wrap.hidden = true;
      browseWrap.hidden = false;
      return;
    }
    wrap.hidden = false;
    browseWrap.hidden = true;

    const s = pendingReview.stats;
    document.getElementById('titolari-review-summary').textContent =
      `${s.teamsParsed} squadre analizzate — ${s.playersMatched} titolari abbinati automaticamente, ${s.playersUnmatched} da verificare manualmente` +
      (s.teamsFailed ? `, ${s.teamsFailed} squadre non riconosciute` : '') + '.';

    document.getElementById('titolari-review-teams').innerHTML = pendingReview.teams.map((t, ti) => renderReviewTeamCard(t, ti)).join('');
  }

  // Aggiorna badge/collapse di UNA card senza ricostruire l'HTML delle altre: così le
  // modifiche alle caselle non ancora salvate nelle altre squadre non vengono perse.
  function updateReviewTeamCardDom(ti) {
    const card = document.querySelector(`.titolari-team-card[data-team-index="${ti}"]`);
    if (!card) return;
    const t = pendingReview.teams[ti];
    card.classList.toggle('collapsed', t.collapsed);
    const badgeSlot = card.querySelector('.titolari-saved-badge-slot');
    if (badgeSlot) badgeSlot.innerHTML = t.saved ? '<span class="titolari-saved-badge">✓ Salvata</span>' : '';
    const toggleIcon = card.querySelector('.titolari-team-toggle');
    if (toggleIcon) toggleIcon.textContent = t.collapsed ? '▸' : '▾';
  }

  function saveReviewTeamByIndex(ti, opts) {
    const t = pendingReview.teams[ti];
    const card = document.querySelector(`.titolari-team-card[data-team-index="${ti}"]`);
    if (!card) return;
    const checked = collectCheckedIds(card);
    upsertTitolariForTeam(t.team, checked);
    t.saved = true;
    t.collapsed = true;
    updateReviewTeamCardDom(ti);
    if (!(opts && opts.silent)) showToast(`Salvata ${t.team}: ${checked.size} titolari.`);
  }

  function saveAllReviewTeams() {
    pendingReview.teams.forEach((t, ti) => saveReviewTeamByIndex(ti, { silent: true }));
    refreshAfterTitolariChange();
    showToast(`Salvate tutte le ${pendingReview.teams.length} squadre.`);
  }

  function wireTitolariReviewTeams() {
    const container = document.getElementById('titolari-review-teams');
    container.addEventListener('click', e => {
      const saveBtn = e.target.closest('.titolari-save-team-btn');
      if (saveBtn) {
        saveReviewTeamByIndex(+saveBtn.dataset.team);
        refreshAfterTitolariChange();
        return;
      }
      const header = e.target.closest('.titolari-team-card-header');
      if (header) {
        const ti = +header.dataset.toggleTeam;
        pendingReview.teams[ti].collapsed = !pendingReview.teams[ti].collapsed;
        updateReviewTeamCardDom(ti);
      }
    });
  }

  function closeTitolariReview() {
    pendingReview = null;
    renderTitolariReview();
    renderTitolariBrowse();
  }

  async function clearTitolariImport() {
    if (!titolariImport) { showToast('Nessun import da svuotare.'); return; }
    if (!(await showConfirm('Svuotare i titolari importati? Il pallino sparirà dal Listone finché non ne salvi di nuovi.'))) return;
    titolariImport = null;
    saveState();
    renderAll();
    showToast('Titolari svuotati.');
  }

  function renderTitolariImportStatus() {
    const el = document.getElementById('titolari-import-status');
    if (titolariImport && titolariImport.meta && titolariImport.entries.length) {
      const d = new Date(titolariImport.meta.updatedAt).toLocaleString('it-IT');
      el.textContent = `${titolariImport.meta.playersMatched} titolari salvati in ${titolariImport.meta.teamsParsed} squadre (ultimo salvataggio: ${d}).`;
      el.classList.add('loaded');
    } else {
      el.textContent = 'Nessun titolare importato: nessun pallino mostrato nel Listone finché non ne salvi.';
      el.classList.remove('loaded');
    }
  }

  // ---- Vista "sfoglia titolari" per ruolo/squadra + modifica manuale di una squadra ----

  let titolariActiveRole = 'P';
  let titolariTeamFilter = '';
  let manualEditTeam = null;

  function renderTitolariBrowse() {
    const map = activeStartersMap();
    const rows = PLAYERS_DATA.filter(p => map[(p.n.trim() + '|' + p.s.trim()).toLowerCase()]);

    const teamSelect = document.getElementById('titolari-team-filter');
    if (document.activeElement !== teamSelect) {
      const teams = [...new Set(PLAYERS_DATA.map(p => p.s))].sort((a, b) => a.localeCompare(b, 'it'));
      const current = teamSelect.value;
      teamSelect.innerHTML = '<option value="">Tutte le squadre</option>' + teams.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
      if (teams.includes(current)) teamSelect.value = current;
    }

    document.querySelectorAll('#titolari-role-tabs .role-tab').forEach(t => t.classList.toggle('active', t.dataset.role === titolariActiveRole));
    document.getElementById('btn-titolari-edit-team').hidden = !titolariTeamFilter || PLAYERS_DATA.length === 0;

    const filtered = rows
      .filter(p => p.r === titolariActiveRole)
      .filter(p => !titolariTeamFilter || p.s === titolariTeamFilter)
      .sort((a, b) => a.s.localeCompare(b.s, 'it') || a.n.localeCompare(b.n, 'it'));

    document.getElementById('titolari-browse-tbody').innerHTML = filtered.map(p => `<tr><td>${escapeHtml(p.n)}</td><td>${escapeHtml(p.s)}</td></tr>`).join('');
    document.getElementById('titolari-empty-state').hidden = filtered.length > 0;
    document.getElementById('titolari-browse-table').hidden = filtered.length === 0;
  }

  // Modifica diretta di una squadra dalla vista "sfoglia", senza dover ripassare da un PDF:
  // stesso editor a caselle di spunta della revisione, precompilato con i titolari attuali.
  function openManualTeamEditor(team) {
    manualEditTeam = team;
    const map = activeStartersMap();
    const checkedIds = new Set(
      PLAYERS_DATA.filter(p => p.s === team && map[(p.n.trim() + '|' + p.s.trim()).toLowerCase()]).map(p => p.id)
    );
    const container = document.getElementById('titolari-team-editor');
    container.innerHTML = `
      <div class="titolari-team-card">
        <div class="titolari-team-card-header">
          <span class="titolari-team-name">Modifica titolari — ${escapeHtml(team)}</span>
        </div>
        <div class="titolari-team-card-body">
          ${renderTeamRoleCheckboxes(team, checkedIds)}
          <div class="titolari-team-card-actions">
            <button type="button" class="btn btn-add" id="btn-titolari-manual-save">Salva squadra</button>
            <button type="button" class="btn btn-remove" id="btn-titolari-manual-cancel">Annulla</button>
          </div>
        </div>
      </div>`;
    container.hidden = false;
    container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeManualTeamEditor() {
    manualEditTeam = null;
    const container = document.getElementById('titolari-team-editor');
    container.hidden = true;
    container.innerHTML = '';
  }

  function wireTitolariPanel() {
    document.getElementById('titolari-file-input').addEventListener('change', e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) handleTitolariPdfImport(file);
    });
    document.getElementById('btn-clear-titolari').addEventListener('click', clearTitolariImport);
    document.getElementById('btn-titolari-save-all').addEventListener('click', saveAllReviewTeams);
    document.getElementById('btn-titolari-close-review').addEventListener('click', closeTitolariReview);
    wireTitolariReviewTeams();

    document.getElementById('titolari-role-tabs').addEventListener('click', e => {
      const btn = e.target.closest('.role-tab');
      if (!btn) return;
      titolariActiveRole = btn.dataset.role;
      renderTitolariBrowse();
    });
    document.getElementById('titolari-team-filter').addEventListener('change', e => {
      titolariTeamFilter = e.target.value;
      closeManualTeamEditor();
      renderTitolariBrowse();
    });
    document.getElementById('btn-titolari-edit-team').addEventListener('click', () => {
      if (titolariTeamFilter) openManualTeamEditor(titolariTeamFilter);
    });
    document.getElementById('titolari-team-editor').addEventListener('click', e => {
      if (e.target.id === 'btn-titolari-manual-save') {
        const container = document.getElementById('titolari-team-editor');
        const checked = collectCheckedIds(container);
        upsertTitolariForTeam(manualEditTeam, checked);
        const team = manualEditTeam;
        closeManualTeamEditor();
        refreshAfterTitolariChange();
        renderTitolariBrowse();
        showToast(`Salvata ${team}: ${checked.size} titolari.`);
      } else if (e.target.id === 'btn-titolari-manual-cancel') {
        closeManualTeamEditor();
      }
    });
  }

  // ---------- Navigazione a schede: il contenitore principale mostra sempre e solo il pannello
  // corrispondente al pulsante del menu attivo, invece di scorrere tra tutti quanti in sequenza.
  const PANEL_IDS = ['sync-panel', 'settings-panel', 'players-panel', 'titolari-panel', 'roster-panel'];
  const ACTIVE_PANEL_STORAGE_KEY = 'fanta_asta_active_panel';

  function showPanel(id) {
    if (!PANEL_IDS.includes(id)) return;
    PANEL_IDS.forEach(pid => {
      document.getElementById(pid).hidden = pid !== id;
    });
    document.querySelectorAll('.quick-nav-link').forEach(link => {
      link.classList.toggle('active', link.getAttribute('href') === `#${id}`);
    });
    window.scrollTo({ top: 0, behavior: 'auto' });
    try { localStorage.setItem(ACTIVE_PANEL_STORAGE_KEY, id); } catch (e) { /* storage non disponibile, pazienza */ }
  }

  function wirePanelNav() {
    // Un solo listener delegato copre sia i pulsanti del menu sia i link interni che rimandano
    // a un altro pannello (es. "vedi pannello Probabili titolari" nel Listone).
    document.addEventListener('click', e => {
      const link = e.target.closest('a[href^="#"]');
      if (!link) return;
      const id = link.getAttribute('href').slice(1);
      if (!PANEL_IDS.includes(id)) return;
      e.preventDefault();
      showPanel(id);
    });

    window.addEventListener('hashchange', () => {
      const id = location.hash.slice(1);
      if (PANEL_IDS.includes(id)) showPanel(id);
    });
  }

  function initialPanelId() {
    const fromHash = location.hash.slice(1);
    if (PANEL_IDS.includes(fromHash)) return fromHash;
    try {
      const saved = localStorage.getItem(ACTIVE_PANEL_STORAGE_KEY);
      if (PANEL_IDS.includes(saved)) return saved;
    } catch (e) { /* storage non disponibile, si usa il default */ }
    return 'players-panel';
  }

  // ---------- Init ----------
  function init() {
    rebuildDerivedIndexes();
    wireEvents();
    wireImport();
    wireStatsImport();
    wireSync();
    wireTitolariPanel();
    wireFormationsArchive();
    wirePanelNav();
    renderAll();
    showPanel(initialPanelId());
    if (sync.teamId) startPolling();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
