(() => {
  const $ = (s) => document.querySelector(s);
  const FILES = 'abcdefgh';
  const VS = '︎'; // force text (non-emoji) glyphs
  const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const REASONS = {
    checkmate: 'במט', resign: 'בכניעה', timeout: 'בזמן', 'timeout-draw': 'נגמר הזמן מול חומר לא מספיק',
    stalemate: 'פט', insufficient: 'חומר לא מספיק', repetition: 'חזרה משולשת', fifty: 'חוק 50 המסעים',
    agreement: 'בהסכמה',
  };
  const COLOR_NAME = { w: 'הלבן', b: 'השחור' };

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // Per-tab identity (survives refresh), so two tabs in one browser can be two players.
  let token = null;
  try { token = sessionStorage.getItem('chess.token'); } catch {}
  if (!token) {
    token = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem('chess.token', token); } catch {}
  }
  let myName = store.get('chess.name', '') || 'שחקן' + Math.floor(1000 + Math.random() * 9000);

  const socket = io();
  let roomCode = null, myColor = null, S = null, pos = {}, legal = [];
  let selected = null, flipped = false, drag = null, localLast = null, clockBase = 0;
  let squareEls = {};
  const boardEl = $('#board');

  // ---------- helpers ----------
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 2500);
  }
  function parseFen(fen) {
    const b = {};
    fen.split(' ')[0].split('/').forEach((row, i) => {
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) f += +ch;
        else { b[FILES[f] + (8 - i)] = { type: ch.toLowerCase(), color: ch === ch.toUpperCase() ? 'w' : 'b' }; f++; }
      }
    });
    return b;
  }
  const opp = (c) => (c === 'w' ? 'b' : 'w');
  const inviteUrl = () => `${location.origin}/?room=${roomCode}`;
  function copy(text) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('הקישור הועתק'), () => toast(text));
    else toast(text);
  }

  // ---------- lobby ----------
  const nameInput = $('#nameInput');
  nameInput.value = myName;
  nameInput.addEventListener('change', () => {
    myName = nameInput.value.trim().slice(0, 20) || myName;
    store.set('chess.name', myName);
  });

  function pickOne(container) {
    container.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      container.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    });
  }
  pickOne($('#tcGrid'));
  pickOne($('#colorPick'));

  $('#btnCreate').addEventListener('click', () => {
    nameInput.dispatchEvent(new Event('change'));
    const tc = $('#tcGrid .on'), col = $('#colorPick .on');
    socket.emit('create', { minutes: +tc.dataset.min, increment: +tc.dataset.inc, color: col.dataset.color }, (res) => {
      if (res && res.code) enterRoom(res.code);
    });
  });
  function joinFromInput() {
    nameInput.dispatchEvent(new Event('change'));
    const code = $('#codeInput').value.trim().toUpperCase();
    if (code.length < 5) return toast('הכנס קוד חדר בן 5 תווים');
    enterRoom(code);
  }
  $('#btnJoin').addEventListener('click', joinFromInput);
  $('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromInput(); });

  function showLobby() {
    $('#lobby').hidden = false;
    $('#game').hidden = true;
  }
  function showGame() {
    $('#lobby').hidden = true;
    $('#game').hidden = false;
  }

  function enterRoom(code) {
    roomCode = code;
    myColor = null;
    S = null;
    flipped = false;
    history.replaceState(null, '', '/?room=' + code);
    $('#chatLog').innerHTML = '';
    if (socket.connected) socket.emit('join', { code, name: myName, token });
    showGame();
    buildBoard();
  }
  function leaveRoom() {
    socket.emit('leave');
    SFX.stopSong();
    roomCode = null; myColor = null; S = null;
    history.replaceState(null, '', '/');
    showLobby();
  }

  // ---------- socket ----------
  socket.on('connect', () => { if (roomCode) socket.emit('join', { code: roomCode, name: myName, token }); });
  socket.on('disconnect', () => toast('החיבור לשרת נותק… מתחבר מחדש'));
  socket.on('err', (e) => {
    toast(e.msg);
    if (e.code === 'notfound') leaveRoom();
  });
  socket.on('joined', ({ color, chat }) => {
    myColor = color;
    buildBoard();
    $('#chatLog').innerHTML = '';
    chat.forEach(addChat);
  });
  socket.on('seat', ({ color }) => {
    myColor = color;
    flipped = false;
    buildBoard();
  });
  socket.on('newgame', () => {
    $('#overModal').hidden = true;
    SFX.stopSong();
    addChat({ sys: true, text: 'משחק חוזר התחיל! הצבעים התחלפו.' });
    SFX.notify();
  });
  socket.on('state', (s) => {
    const prev = S;
    S = s;
    pos = parseFen(s.fen);
    legal = s.legal;
    localLast = null;
    clockBase = performance.now();
    if (selected && !canMoveFrom(selected)) selected = null;
    if (!squareEls.e1) buildBoard();
    render();
    if (prev && prev.status === 'waiting' && s.status === 'playing') {
      SFX.notify();
      addChat({ sys: true, text: 'היריב הצטרף — בהצלחה!' });
    }
    if (prev && prev.status === 'playing' && s.status === 'over') showGameOver();
  });
  socket.on('moved', (m) => {
    // Checkmate gets the song, check gets "holy shit", everything else the piece's voice.
    if (m.mate) SFX.play('mate');
    else if (m.check) SFX.play('check');
    else SFX.play(m.piece);
    if (m.captured) SFX.capture();
    if (m.color !== myColor && navigator.vibrate) navigator.vibrate(m.check ? [30, 40, 30] : 20);
  });
  socket.on('chat', addChat);

  // ---------- board ----------
  function orientation() {
    const base = myColor === 'b' ? 'b' : 'w';
    return flipped ? opp(base) : base;
  }
  function buildBoard() {
    boardEl.innerHTML = '';
    squareEls = {};
    const bottom = orientation();
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const rank = bottom === 'w' ? 8 - r : r + 1;
        const file = bottom === 'w' ? f : 7 - f;
        const sq = FILES[file] + rank;
        const d = document.createElement('div');
        d.className = 'sq ' + ((file + rank) % 2 === 0 ? 'light' : 'dark');
        d.dataset.sq = sq;
        if (f === 0) d.insertAdjacentHTML('beforeend', `<span class="coord rank">${rank}</span>`);
        if (r === 7) d.insertAdjacentHTML('beforeend', `<span class="coord file">${FILES[file]}</span>`);
        boardEl.appendChild(d);
        squareEls[sq] = d;
      }
    }
    render();
  }

  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--sq', boardEl.clientWidth / 8 + 'px');
  }).observe(boardEl);

  function targetsOf(sq) {
    return [...new Set(legal.filter((m) => m.from === sq).map((m) => m.to))];
  }
  function canMoveFrom(sq) {
    return !!(S && S.status === 'playing' && myColor && S.turn === myColor && pos[sq] && pos[sq].color === myColor);
  }

  function render() {
    if (!S) return;
    renderBoard();
    renderBars();
    renderMoves();
    renderPanel();
  }

  function renderBoard() {
    const last = localLast || (S.moves.length ? S.moves[S.moves.length - 1] : null);
    let checkSq = null;
    if (S.inCheck && !localLast) checkSq = Object.keys(pos).find((sq) => pos[sq].type === 'k' && pos[sq].color === S.turn);
    for (const sq in squareEls) {
      const el = squareEls[sq];
      el.classList.toggle('last', !!last && (last.from === sq || last.to === sq));
      el.classList.toggle('check', sq === checkSq);
      const p = pos[sq];
      let pe = el.querySelector('.piece');
      if (p) {
        if (!pe) { pe = document.createElement('div'); el.appendChild(pe); }
        pe.className = 'piece ' + p.color;
        pe.textContent = GLYPH[p.type] + VS;
      } else if (pe) pe.remove();
    }
    renderHighlights();
  }

  function renderHighlights() {
    const t = selected ? targetsOf(selected) : [];
    for (const sq in squareEls) {
      const el = squareEls[sq];
      el.classList.toggle('sel', sq === selected);
      el.classList.toggle('target', t.includes(sq) && !pos[sq]);
      el.classList.toggle('capture', t.includes(sq) && !!pos[sq]);
    }
  }

  function material(color) {
    return Object.values(pos).filter((p) => p.color === color).reduce((s, p) => s + VALUE[p.type], 0);
  }

  function renderBars() {
    const bottom = orientation();
    fillBar($('#barTop'), opp(bottom));
    fillBar($('#barBottom'), bottom);
  }
  function fillBar(el, color) {
    const p = S.players[color];
    el.querySelector('.pname').textContent = p ? p.name : 'ממתין ליריב…';
    el.querySelector('.avatar').className = 'avatar ' + color;
    el.querySelector('.you').hidden = color !== myColor;
    el.querySelector('.dot').className = 'dot' + (p && p.connected ? ' on' : '');
    const caps = S.moves.filter((m) => m.color === color && m.captured).map((m) => m.captured)
      .sort((a, b) => VALUE[a] - VALUE[b]);
    const adv = material(color) - material(opp(color));
    el.querySelector('.caps').innerHTML =
      caps.map((t) => `<span class="cap ${opp(color)}">${GLYPH[t]}${VS}</span>`).join('') +
      (adv > 0 ? `<span class="adv">+${adv}</span>` : '');
    el.querySelector('.clock').dataset.color = color;
  }

  function renderMoves() {
    const ml = $('#moves');
    const n = S.moves.length;
    let html = '';
    for (let i = 0; i < n; i += 2) {
      const w = S.moves[i], b = S.moves[i + 1];
      html += `<div class="mrow"><span class="mn">${i / 2 + 1}.</span>` +
        `<span class="mv${i === n - 1 ? ' cur' : ''}">${w.san}</span>` +
        `<span class="mv${i + 1 === n - 1 ? ' cur' : ''}">${b ? b.san : ''}</span></div>`;
    }
    ml.innerHTML = html;
    ml.scrollTop = ml.scrollHeight;
    ml.scrollLeft = ml.scrollWidth; // phone: horizontal move strip
  }

  function resultText() {
    if (!S.winner) return 'תיקו';
    if (myColor) return S.winner === myColor ? 'ניצחת! 🎉' : 'הפסדת';
    return `${COLOR_NAME[S.winner]} ניצח`;
  }

  function renderPanel() {
    $('#roomCode').textContent = S.code;
    $('#tcLabel').textContent = S.base == null ? '· ללא שעון' : `· ${S.base / 60000}${S.inc ? ' | ' + S.inc / 1000 : ''} דק'`;
    const waiting = S.status === 'waiting';
    $('#invite').hidden = !waiting;
    $('#waitOverlay').hidden = !waiting;
    $('#inviteLink').value = inviteUrl();

    let st;
    if (waiting) st = 'ממתין ליריב…';
    else if (S.status === 'over') st = `${resultText()} · ${REASONS[S.reason] || ''}`;
    else if (myColor) st = S.turn === myColor ? (S.inCheck ? 'תורך — שח!' : 'תורך') : 'תור היריב';
    else st = `תור ${COLOR_NAME[S.turn]}`;
    $('#status').textContent = st;

    const playing = S.status === 'playing' && !!myColor;
    $('#btnResign').hidden = !playing;
    $('#btnDraw').hidden = !playing;
    $('#btnDraw').disabled = S.drawOffer === myColor;
    $('#btnDraw .lb').textContent = S.drawOffer === myColor ? 'נשלחה הצעה' : 'הצע תיקו';
    $('#drawBanner').hidden = !(playing && S.drawOffer && S.drawOffer !== myColor);

    const over = S.status === 'over' && !!myColor;
    const iAsked = S.rematch.includes(myColor), theyAsked = S.rematch.includes(opp(myColor));
    const label = iAsked ? 'ממתין ליריב…' : theyAsked ? 'קבל משחק חוזר' : 'משחק חוזר';
    for (const b of [$('#btnRematch'), $('#btnOverRematch')]) {
      b.hidden = !over;
      b.disabled = iAsked;
      b.querySelector('.lb').textContent = label;
    }
    $('#spectatorNote').hidden = !!myColor;
  }

  function fmtClock(ms) {
    if (ms >= 10000) {
      const s = Math.ceil(ms / 1000);
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
      return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
    }
    return `0:0${Math.floor(ms / 1000)}.${Math.floor((ms % 1000) / 100)}`;
  }
  setInterval(() => {
    if (!S) return;
    document.querySelectorAll('.pbar .clock').forEach((el) => {
      const c = el.dataset.color;
      if (!c || S.clocks[c] == null) { el.textContent = ''; return; }
      let ms = S.clocks[c];
      if (S.running === c) ms = Math.max(0, ms - (performance.now() - clockBase));
      el.textContent = fmtClock(ms);
      el.classList.toggle('active', S.running === c || (S.status === 'playing' && S.turn === c));
      el.classList.toggle('low', ms < 20000);
    });
  }, 100);

  // ---------- input ----------
  boardEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest('.sq');
    if (!el) return;
    const sq = el.dataset.sq;
    if (selected && selected !== sq && targetsOf(selected).includes(sq)) return attemptMove(selected, sq);
    if (canMoveFrom(sq)) {
      e.preventDefault();
      const wasSelected = selected === sq;
      selected = sq;
      renderHighlights();
      startDrag(e, sq, wasSelected);
    } else {
      selected = null;
      renderHighlights();
    }
  });

  function startDrag(e, sq, wasSelected) {
    const pieceEl = squareEls[sq].querySelector('.piece');
    if (!pieceEl) return;
    const ghost = pieceEl.cloneNode(true);
    ghost.classList.add('ghost');
    document.body.appendChild(ghost);
    pieceEl.classList.add('dragging');
    drag = { from: sq, ghost, pieceEl, wasSelected, moved: false, x: e.clientX, y: e.clientY, hover: null };
    placeGhost(e.clientX, e.clientY);
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragEnd);
  }
  function placeGhost(x, y) {
    drag.ghost.style.left = x + 'px';
    drag.ghost.style.top = y + 'px';
  }
  function squareAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el && el.closest('.sq') ? el.closest('.sq').dataset.sq : null;
  }
  function onDragMove(e) {
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
    placeGhost(e.clientX, e.clientY);
    const sq = squareAt(e.clientX, e.clientY);
    if (sq !== drag.hover) {
      if (drag.hover) squareEls[drag.hover].classList.remove('hover');
      drag.hover = sq;
      if (sq && drag.moved) squareEls[sq].classList.add('hover');
    }
  }
  function onDragEnd(e) {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragEnd);
    const d = drag;
    drag = null;
    if (!d) return;
    d.ghost.remove();
    d.pieceEl.classList.remove('dragging');
    if (d.hover) squareEls[d.hover].classList.remove('hover');
    if (e.type === 'pointercancel') return;
    const to = squareAt(e.clientX, e.clientY);
    if (to && to !== d.from && targetsOf(d.from).includes(to)) attemptMove(d.from, to);
    else if (to === d.from && d.wasSelected && !d.moved) { selected = null; renderHighlights(); }
  }

  function attemptMove(from, to) {
    const p = pos[from];
    if (p.type === 'p' && (to[1] === '8' || to[1] === '1')) return askPromotion(from, to, p.color);
    sendMove(from, to);
  }

  function askPromotion(from, to, color) {
    const row = $('#promoRow');
    row.innerHTML = '';
    for (const t of ['q', 'r', 'b', 'n']) {
      const b = document.createElement('button');
      b.className = 'piece ' + color;
      b.textContent = GLYPH[t] + VS;
      b.onclick = () => { $('#promoModal').hidden = true; sendMove(from, to, t); };
      row.appendChild(b);
    }
    $('#promoModal').hidden = false;
  }

  function sendMove(from, to, promotion) {
    const p = pos[from];
    // Optimistic local update; the server's state replaces it right away.
    delete pos[from];
    if (p.type === 'p' && from[0] !== to[0] && !pos[to]) delete pos[to[0] + from[1]];
    if (p.type === 'k' && Math.abs(FILES.indexOf(to[0]) - FILES.indexOf(from[0])) === 2) {
      const r = from[1], [rf, rt] = to[0] === 'g' ? ['h', 'f'] : ['a', 'd'];
      pos[rt + r] = pos[rf + r];
      delete pos[rf + r];
    }
    pos[to] = promotion ? { type: promotion, color: p.color } : p;
    localLast = { from, to };
    legal = [];
    selected = null;
    renderBoard();
    if (navigator.vibrate) navigator.vibrate(15);
    socket.emit('move', { from, to, promotion });
  }

  // ---------- panel actions ----------
  $('#btnFlip').onclick = () => { flipped = !flipped; buildBoard(); };
  $('#btnShare').onclick = () => copy(inviteUrl());
  $('#btnCopy').onclick = () => copy(inviteUrl());
  $('#btnNew').onclick = () => {
    if (S && S.status === 'playing' && myColor && !confirm('לעזוב את המשחק הנוכחי?')) return;
    leaveRoom();
  };
  $('#btnResign').onclick = () => { if (confirm('בטוח שאתה רוצה להיכנע?')) socket.emit('resign'); };
  $('#btnDraw').onclick = () => socket.emit('draw', 'offer');
  $('#btnDrawAccept').onclick = () => socket.emit('draw', 'accept');
  $('#btnDrawDecline').onclick = () => socket.emit('draw', 'decline');
  $('#btnRematch').onclick = $('#btnOverRematch').onclick = () => socket.emit('rematch');

  function showGameOver() {
    const win = S.winner;
    $('#overIcon').innerHTML = win ? `<span class="glyph ${win}">${GLYPH.k}${VS}</span>` : '½';
    $('#overTitle').textContent = resultText();
    $('#overReason').textContent = win ? `${COLOR_NAME[win]} ניצח ${REASONS[S.reason] || ''}` : REASONS[S.reason] || '';
    $('#overModal').hidden = false;
    if (S.reason === 'checkmate') return; // the mate song is already playing
    if (myColor && win === myColor) SFX.play('k');
    else SFX.notify();
  }

  // ---------- chat ----------
  function addChat(m) {
    const log = $('#chatLog');
    const div = document.createElement('div');
    if (m.sys) {
      div.className = 'sys';
      div.textContent = m.text;
    } else {
      div.className = 'msg';
      const b = document.createElement('b');
      b.textContent = m.name + ':';
      div.append(b, document.createTextNode(' ' + m.text));
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    if (!document.body.classList.contains('chat-open')) $('#chatBadge').hidden = false;
  }
  function setChatOpen(open) {
    document.body.classList.toggle('chat-open', open);
    if (open) $('#chatBadge').hidden = true;
  }
  $('#btnChat').onclick = () => setChatOpen(!document.body.classList.contains('chat-open'));
  boardEl.addEventListener('pointerdown', () => setChatOpen(false));
  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#chatInput');
    if (inp.value.trim()) socket.emit('chat', inp.value);
    inp.value = '';
  });

  // ---------- settings ----------
  const soundToggle = $('#soundToggle'), volume = $('#volume'), speechToggle = $('#speechToggle');
  soundToggle.checked = SFX.settings.enabled;
  volume.value = SFX.settings.volume;
  speechToggle.checked = SFX.settings.speech;
  soundToggle.onchange = () => { SFX.set('enabled', soundToggle.checked); if (soundToggle.checked) SFX.unlock(); };
  volume.oninput = () => SFX.set('volume', +volume.value);
  speechToggle.onchange = () => SFX.set('speech', speechToggle.checked);
  $('#testGrid').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    SFX.unlock();
    if (b.dataset.p === 'stop') SFX.stopSong();
    else SFX.play(b.dataset.p, true);
  });
  $('#btnSettings').onclick = () => { $('#settingsModal').hidden = false; };

  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) m.hidden = true;
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => (m.hidden = true));
  });
  // Browsers only allow audio after a user gesture (iOS wants touchend/click).
  for (const ev of ['pointerdown', 'touchend', 'click']) document.addEventListener(ev, () => SFX.unlock(), { once: true });

  // ---------- boot ----------
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) enterRoom(urlRoom.toUpperCase());
  else showLobby();
})();
