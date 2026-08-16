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
    ignoreKeys: []
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
  let sync = initial.sync; // collegamento con Asta Live (vedi DEFAULT_SYNC)
  // Probabili titolari importati da PDF (vedi sezione dedicata più sotto): quando presente,
  // sostituisce integralmente il fallback statico LIKELY_STARTERS di starters.js.
  let titolariImport = initial.titolariImport; // { entries:[{id,n,s,r}], meta:{...} } | null
  let activeRole = 'P';
  let searchTerm = '';
  let sortKey = 'qa';
  let sortDir = 'desc';

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
    computeConvenienzaTiers();
  }

  // ---------- Persistence ----------
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { settings: { ...DEFAULT_SETTINGS, pct: { ...DEFAULT_SETTINGS.pct } }, roster: [], players: [], playersMeta: null, sync: { ...DEFAULT_SYNC }, titolariImport: null };
      const parsed = JSON.parse(raw);
      return {
        settings: { ...DEFAULT_SETTINGS, ...parsed.settings, pct: { ...DEFAULT_SETTINGS.pct, ...(parsed.settings && parsed.settings.pct) } },
        roster: Array.isArray(parsed.roster) ? parsed.roster : [],
        players: Array.isArray(parsed.players) ? parsed.players : [],
        playersMeta: parsed.playersMeta || null,
        sync: {
          ...DEFAULT_SYNC,
          ...(parsed.sync || {}),
          ignoreKeys: Array.isArray(parsed.sync && parsed.sync.ignoreKeys) ? parsed.sync.ignoreKeys : []
        },
        titolariImport: (parsed.titolariImport && Array.isArray(parsed.titolariImport.entries)) ? parsed.titolariImport : null
      };
    } catch (e) {
      return { settings: { ...DEFAULT_SETTINGS, pct: { ...DEFAULT_SETTINGS.pct } }, roster: [], players: [], playersMeta: null, sync: { ...DEFAULT_SYNC }, titolariImport: null };
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, roster, players: PLAYERS_DATA, playersMeta, sync, titolariImport }));
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
    const min = Math.max(1, Math.round(qa * factor * 0.75));
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
      const card = document.createElement('div');
      card.className = 'role-budget-card';
      card.innerHTML = `
        <span class="role-tag role-${role}">${role}</span>
        <span class="rb-figures">
          <div>piano ${pianoIniziale.toFixed(0)} FM &middot; ~${avg.toFixed(1)}/slot</div>
          <div class="rb-avg">fattore reparto: ${hasPlayers ? factor.toFixed(2) + 'x quot.' : '— (carica il listone)'}</div>
          <div class="rb-avg">speso ${speso.toFixed(0)} &middot; ribilanciato <span class="${rimanente < 0 ? 'rb-over' : ''}">${rimanente.toFixed(0)}</span> FM${emptySlots > 0 ? ` (~${mediaSlot.toFixed(1)}/slot)` : ' (completo)'}</div>
        </span>
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

  // ---------- Rendering: Players table ----------
  function renderTable() {
    renderRoleSpendStrip();

    const tbody = document.getElementById('players-tbody');
    tbody.innerHTML = '';

    let list = PLAYERS_DATA.filter(p => p.r === activeRole);

    if (searchTerm.trim()) {
      const q = searchTerm.trim().toLowerCase();
      list = list.filter(p => p.n.toLowerCase().includes(q) || p.s.toLowerCase().includes(q));
    }

    list = list.slice().sort((a, b) => {
      let va, vb;
      if (sortKey === 'qa') { va = a.qa; vb = b.qa; }
      else if (sortKey === 'fvm') { va = a.fvm; vb = b.fvm; }
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
      tr.innerHTML = `<td colspan="7" class="no-results">Nessun giocatore trovato.</td>`;
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

      if (p.excl) tr.classList.add('excluded');

      const slotFull = counts[p.r] >= SLOTS_PER_ROLE[p.r];
      const disableAdd = p.excl || inRoster || slotFull;
      let addLabel = 'Aggiungi';
      if (inRoster) addLabel = 'In rosa';
      else if (p.excl) addLabel = 'Non acq.';
      else if (slotFull) addLabel = 'Slot pieno';

      const starterKey = (p.n.trim() + '|' + p.s.trim()).toLowerCase();
      const isStarter = activeStartersMap()[starterKey];
      const starterMark = isStarter
        ? `<span class="starter-dot" title="${escapeHtml(startersTitle())}">●</span> `
        : '';

      tr.innerHTML = `
        <td class="player-name">${starterMark}${escapeHtml(p.n)}${p.excl ? ' <span class="excl-badge" title="Tra i 5 giocatori più quotati del ruolo: non acquistabile per regola di lega (off-limits)">off-limits</span>' : ''}</td>
        <td>${escapeHtml(p.s)}</td>
        <td class="mono-cell">${p.qa}</td>
        <td class="mono-cell">${p.fvm}</td>
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
        card.innerHTML = `
          <div class="roster-card-info">
            <div class="roster-card-name">${escapeHtml(entry.player.n)}${entry.synced ? '<span class="synced-badge" title="Aggiunto automaticamente da Asta Live">Sync</span>' : ''}</div>
            <div class="roster-card-team">${escapeHtml(entry.player.s)}</div>
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

  // ---------- Full render ----------
  function renderAll() {
    document.body.classList.toggle('no-players', PLAYERS_DATA.length === 0);
    renderImportStatus();
    renderDashboard();
    renderSettings();
    renderTable();
    renderRoster();
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
  }

  function startPolling() {
    stopPolling();
    if (!sync.teamId) return;
    syncTick();
    syncTimer = setInterval(syncTick, SYNC_POLL_INTERVAL_MS);
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

  // ---- Revisione (obbligatoria prima di salvare, vedi SPEC §6) ----

  let pendingReview = null; // { teams:[{team, rows:[{role,ocrText,candidates,matchedId,included}]}], stats:{...}, fileName }

  function buildPendingReview(panelResults) {
    const teams = [];
    let playersMatched = 0, playersUnmatched = 0, teamsFailed = 0;

    panelResults.forEach(res => {
      const teamLabel = matchTeamName(res.team) || res.team || 'Squadra non riconosciuta';
      if (!res.team || res.dotsFound === 0) teamsFailed++;

      const rows = res.matched.map(m => {
        const candidates = PLAYERS_DATA.filter(p => p.r === m.role && normalizeNameForMatch(p.s) === normalizeNameForMatch(teamLabel));
        const auto = bestNameMatch(m.ocrText, candidates);
        if (auto) playersMatched++; else playersUnmatched++;
        return { role: m.role, ocrText: m.ocrText, candidates, matchedId: auto ? auto.id : null, included: true };
      });

      teams.push({ team: teamLabel, rows });
    });

    pendingReview = { teams, stats: { playersMatched, playersUnmatched, teamsParsed: panelResults.length, teamsFailed } };
  }

  function renderPlayerMatchSelect(row, ti, ri) {
    if (row.candidates.length === 0) {
      return `<span class="hint">Nessun ${ROLE_LABELS[row.role].toLowerCase()} trovato per questa squadra nel listone</span>`;
    }
    const opts = ['<option value="">— seleziona —</option>']
      .concat(row.candidates.map(p => `<option value="${p.id}" ${p.id === row.matchedId ? 'selected' : ''}>${escapeHtml(p.n)}</option>`));
    return `<select class="mono-input titolari-match-select" data-team="${ti}" data-row="${ri}">${opts.join('')}</select>`;
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

    const roleOptions = ROLES.map(r => `<option value="${r}">${r}</option>`).join('');
    let html = '';
    pendingReview.teams.forEach((t, ti) => {
      html += `<tr class="titolari-team-row"><td colspan="4">${escapeHtml(t.team)} <span class="hint">(${t.rows.length} rilevati)</span></td></tr>`;
      t.rows.forEach((r, ri) => {
        html += `
          <tr class="titolari-review-row${r.matchedId ? '' : ' unmatched'}">
            <td><input type="checkbox" class="titolari-include" data-team="${ti}" data-row="${ri}" ${r.included ? 'checked' : ''}></td>
            <td><span class="role-tag role-${r.role}">${r.role}</span></td>
            <td class="titolari-ocr-text">${escapeHtml(r.ocrText)}</td>
            <td>${renderPlayerMatchSelect(r, ti, ri)}</td>
          </tr>`;
      });
      html += `
        <tr class="titolari-add-row" data-team="${ti}">
          <td></td>
          <td colspan="3">
            + Aggiungi titolare mancante:
            <select class="mono-input titolari-add-role" data-team="${ti}">${roleOptions}</select>
            <select class="mono-input titolari-add-player" data-team="${ti}"></select>
            <button type="button" class="btn btn-add titolari-add-btn" data-team="${ti}">Aggiungi</button>
          </td>
        </tr>`;
    });
    document.getElementById('titolari-review-tbody').innerHTML = html;

    pendingReview.teams.forEach((t, ti) => populateAddPlayerSelect(ti));
  }

  function populateAddPlayerSelect(ti) {
    const team = pendingReview.teams[ti];
    const roleSel = document.querySelector(`.titolari-add-role[data-team="${ti}"]`);
    const playerSel = document.querySelector(`.titolari-add-player[data-team="${ti}"]`);
    if (!roleSel || !playerSel) return;
    const role = roleSel.value;
    const usedIds = new Set(team.rows.map(r => r.matchedId).filter(Boolean));
    const options = PLAYERS_DATA.filter(p => p.r === role && normalizeNameForMatch(p.s) === normalizeNameForMatch(team.team) && !usedIds.has(p.id));
    playerSel.innerHTML = options.length
      ? options.map(p => `<option value="${p.id}">${escapeHtml(p.n)}</option>`).join('')
      : '<option value="">Nessuno disponibile</option>';
  }

  function wireTitolariReviewTable() {
    const tbody = document.getElementById('titolari-review-tbody');
    tbody.addEventListener('change', e => {
      if (e.target.classList.contains('titolari-include')) {
        const ti = +e.target.dataset.team, ri = +e.target.dataset.row;
        pendingReview.teams[ti].rows[ri].included = e.target.checked;
      } else if (e.target.classList.contains('titolari-match-select')) {
        const ti = +e.target.dataset.team, ri = +e.target.dataset.row;
        pendingReview.teams[ti].rows[ri].matchedId = e.target.value ? +e.target.value : null;
        renderTitolariReview();
      } else if (e.target.classList.contains('titolari-add-role')) {
        populateAddPlayerSelect(+e.target.dataset.team);
      }
    });
    tbody.addEventListener('click', e => {
      const btn = e.target.closest('.titolari-add-btn');
      if (!btn) return;
      const ti = +btn.dataset.team;
      const playerSel = document.querySelector(`.titolari-add-player[data-team="${ti}"]`);
      if (!playerSel || !playerSel.value) return;
      const player = playersById.get(+playerSel.value);
      if (!player) return;
      const team = pendingReview.teams[ti];
      team.rows.push({
        role: player.r,
        ocrText: '(aggiunto a mano)',
        candidates: PLAYERS_DATA.filter(p => p.r === player.r && normalizeNameForMatch(p.s) === normalizeNameForMatch(team.team)),
        matchedId: player.id,
        included: true
      });
      renderTitolariReview();
    });
  }

  function confirmTitolariReview() {
    if (!pendingReview) return;
    const entries = [];
    pendingReview.teams.forEach(t => {
      t.rows.forEach(r => {
        if (!r.included || !r.matchedId) return;
        const p = playersById.get(r.matchedId);
        if (p) entries.push({ id: p.id, n: p.n, s: p.s, r: p.r });
      });
    });
    if (entries.length === 0) {
      showToast('Nessun titolare abbinato: import annullato.', 'error');
      return;
    }
    titolariImport = {
      entries,
      meta: { importedAt: new Date().toISOString(), fileName: pendingReview.fileName || null, teamsParsed: pendingReview.stats.teamsParsed, playersMatched: entries.length }
    };
    pendingReview = null;
    saveState();
    renderAll();
    showToast(`Titolari aggiornati: ${entries.length} giocatori abbinati.`);
  }

  function cancelTitolariReview() {
    pendingReview = null;
    renderTitolariReview();
  }

  async function clearTitolariImport() {
    if (!titolariImport) { showToast('Nessun import da svuotare.'); return; }
    if (!(await showConfirm('Svuotare i titolari importati? Il pallino sparirà dal Listone finché non importi di nuovo un PDF.'))) return;
    titolariImport = null;
    saveState();
    renderAll();
    showToast('Titolari svuotati.');
  }

  function renderTitolariImportStatus() {
    const el = document.getElementById('titolari-import-status');
    if (titolariImport && titolariImport.meta) {
      const d = new Date(titolariImport.meta.importedAt).toLocaleString('it-IT');
      el.textContent = `Import attivo: ${titolariImport.meta.playersMatched} titolari da ${titolariImport.meta.teamsParsed} squadre analizzate (${d}).`;
      el.classList.add('loaded');
    } else {
      el.textContent = 'Nessun titolare importato: nessun pallino mostrato nel Listone finché non carichi e confermi un PDF.';
      el.classList.remove('loaded');
    }
  }

  // ---- Vista "sfoglia titolari" per ruolo/squadra ----

  let titolariActiveRole = 'P';
  let titolariTeamFilter = '';

  function renderTitolariBrowse() {
    const map = activeStartersMap();
    const rows = PLAYERS_DATA.filter(p => map[(p.n.trim() + '|' + p.s.trim()).toLowerCase()]);

    const teamSelect = document.getElementById('titolari-team-filter');
    if (document.activeElement !== teamSelect) {
      const teams = [...new Set(rows.map(p => p.s))].sort((a, b) => a.localeCompare(b, 'it'));
      const current = teamSelect.value;
      teamSelect.innerHTML = '<option value="">Tutte le squadre</option>' + teams.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
      if (teams.includes(current)) teamSelect.value = current;
    }

    document.querySelectorAll('#titolari-role-tabs .role-tab').forEach(t => t.classList.toggle('active', t.dataset.role === titolariActiveRole));

    const filtered = rows
      .filter(p => p.r === titolariActiveRole)
      .filter(p => !titolariTeamFilter || p.s === titolariTeamFilter)
      .sort((a, b) => a.s.localeCompare(b.s, 'it') || a.n.localeCompare(b.n, 'it'));

    document.getElementById('titolari-browse-tbody').innerHTML = filtered.map(p => `<tr><td>${escapeHtml(p.n)}</td><td>${escapeHtml(p.s)}</td></tr>`).join('');
    document.getElementById('titolari-empty-state').hidden = filtered.length > 0;
    document.getElementById('titolari-browse-table').hidden = filtered.length === 0;
  }

  function wireTitolariPanel() {
    document.getElementById('titolari-file-input').addEventListener('change', e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) handleTitolariPdfImport(file);
    });
    document.getElementById('btn-clear-titolari').addEventListener('click', clearTitolariImport);
    document.getElementById('btn-titolari-confirm').addEventListener('click', confirmTitolariReview);
    document.getElementById('btn-titolari-cancel').addEventListener('click', cancelTitolariReview);
    wireTitolariReviewTable();

    document.getElementById('titolari-role-tabs').addEventListener('click', e => {
      const btn = e.target.closest('.role-tab');
      if (!btn) return;
      titolariActiveRole = btn.dataset.role;
      renderTitolariBrowse();
    });
    document.getElementById('titolari-team-filter').addEventListener('change', e => {
      titolariTeamFilter = e.target.value;
      renderTitolariBrowse();
    });
  }

  // ---------- Sticky header offset (for anchor-scroll targets) ----------
  function updateHeaderOffset() {
    const header = document.getElementById('scoreboard');
    document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
  }

  // ---------- Init ----------
  function init() {
    rebuildDerivedIndexes();
    wireEvents();
    wireImport();
    wireSync();
    wireTitolariPanel();
    renderAll();
    updateHeaderOffset();
    window.addEventListener('resize', updateHeaderOffset);
    if (sync.teamId) startPolling();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
