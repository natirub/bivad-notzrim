/* ══════════════════════════════════════════════
   ביחד נוצרים — Client Logic
   ══════════════════════════════════════════════ */

// ─── Session persistence ──────────────────────────────────────────────────────
// A stable ID stored in localStorage so we can reconnect after refresh/network drop

let sessionId = localStorage.getItem('bvn_session');
if (!sessionId) {
  sessionId = Math.random().toString(36).substr(2) + Date.now().toString(36);
  localStorage.setItem('bvn_session', sessionId);
}

const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  gameId:       null,
  playerName:   null,
  playerIndex:  null,
  opponentName: null,
  currentRound: 0,
  shareLink:    null,
  myAnswer:     null,
  results:      []
};

// ─── Screen management ────────────────────────────────────────────────────────

const HUD_SCREENS = new Set([
  's-gamestart', 's-round', 's-submitted', 's-generating', 's-guessing', 's-result', 's-timeout'
]);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });

  const hud = document.getElementById('hud');
  hud.style.display = HUD_SCREENS.has(id) ? 'flex' : 'none';
  document.body.classList.toggle('has-hud', HUD_SCREENS.has(id));
}

// ─── HUD helpers ──────────────────────────────────────────────────────────────

function updateHud(scores, roundNumber) {
  if (scores) {
    document.getElementById('hud-score0').textContent = scores[0];
    document.getElementById('hud-score1').textContent = scores[1];
  }
  if (roundNumber !== undefined) {
    document.getElementById('hud-round').textContent =
      roundNumber ? `סיבוב ${roundNumber}` : '';
  }
}

// ─── Reconnect banner ─────────────────────────────────────────────────────────

function showBanner(text) {
  const el = document.getElementById('reconnect-banner');
  document.getElementById('reconnect-banner-text').textContent = text;
  el.style.display = 'flex';
}

function hideBanner() {
  document.getElementById('reconnect-banner').style.display = 'none';
}

// ─── URL parsing ──────────────────────────────────────────────────────────────

const urlParams = new URLSearchParams(window.location.search);
const urlGameId = urlParams.get('game');

window.addEventListener('DOMContentLoaded', () => {
  if (urlGameId) {
    showScreen('s-join');
    setTimeout(() => document.getElementById('join-name').focus(), 100);
  } else {
    showScreen('s-create');
    setTimeout(() => document.getElementById('create-name').focus(), 100);
  }
});

// ─── Try to restore session on every (re)connect ─────────────────────────────

socket.on('connect', () => {
  const savedGameId = localStorage.getItem('bvn_game');
  if (savedGameId) {
    socket.emit('restore-session', { sessionId, gameId: savedGameId });
  }
});

// ─── Enter-key helpers ────────────────────────────────────────────────────────

document.getElementById('create-name').addEventListener('keydown',  e => { if (e.key === 'Enter') App.createGame(); });
document.getElementById('join-name').addEventListener('keydown',    e => { if (e.key === 'Enter') App.joinGame(); });
document.getElementById('answer-input').addEventListener('keydown', e => { if (e.key === 'Enter') App.submitAnswer(); });
document.getElementById('guess-input').addEventListener('keydown',  e => { if (e.key === 'Enter') App.submitGuess(); });

// ─── Public API ───────────────────────────────────────────────────────────────

const App = {

  createGame() {
    const name = document.getElementById('create-name').value.trim();
    if (!name) return shake('create-name');
    state.playerName  = name;
    state.playerIndex = 0;
    socket.emit('create-game', { playerName: name, sessionId });
  },

  joinGame() {
    const name = document.getElementById('join-name').value.trim();
    if (!name) return shake('join-name');
    state.playerName  = name;
    state.playerIndex = 1;
    state.gameId      = (urlGameId || '').toUpperCase().trim();
    localStorage.setItem('bvn_game', state.gameId);
    socket.emit('join-game', { gameId: urlGameId, playerName: name, sessionId });
  },

  copyLink() {
    const link = state.shareLink;
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => {
      const btn = document.querySelector('.copy-btn');
      const orig = btn.textContent;
      btn.textContent = '✓ הועתק!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    });
  },

  playerReady() {
    const btn = document.getElementById('ready-btn');
    btn.disabled    = true;
    btn.textContent = 'מוכן! ממתין לשחקן השני...';
    document.getElementById('ready-status').textContent = 'ממתין שגם השחקן השני יהיה מוכן...';
    socket.emit('player-ready');
  },

  submitAnswer() {
    const input  = document.getElementById('answer-input');
    const answer = input.value.trim();
    if (!answer) return shake('answer-input');

    state.myAnswer = answer;
    document.getElementById('submit-btn').disabled = true;
    input.disabled = true;

    stopAnswerTimer();
    socket.emit('submit-answer', { answer });

    const opName = state.opponentName || 'השחקן השני';
    document.getElementById('submitted-title').textContent  = 'התשובה שלך נשלחה!';
    document.getElementById('waiting-for-text').textContent = `ממתין ל${opName}...`;
    showScreen('s-submitted');
  },

  submitGuess() {
    const input = document.getElementById('guess-input');
    const guess = input.value.trim();
    if (!guess) return shake('guess-input');

    document.getElementById('guess-btn').disabled = true;
    input.disabled = true;

    socket.emit('submit-guess', { guess });

    const opName = state.opponentName || 'השחקן השני';
    document.getElementById('submitted-title').textContent  = 'הניחוש שלך נשלח!';
    document.getElementById('waiting-for-text').textContent = `ממתין ש${opName} ינחש...`;
    showScreen('s-submitted');
  },

  nextRound() {
    socket.emit('next-round');
    const btn = document.getElementById('next-btn');
    btn.disabled    = true;
    btn.textContent = 'ממתין...';
  },

  openLightbox(src) {
    document.getElementById('lightbox-img').src = src;
    document.getElementById('lightbox').classList.add('open');
  },

  closeLightbox() {
    document.getElementById('lightbox').classList.remove('open');
  }
};

// ─── Shake animation helper ───────────────────────────────────────────────────

function shake(inputId) {
  const el = document.getElementById(inputId);
  el.style.animation = 'none';
  el.offsetHeight;
  el.style.animation = 'shake 0.4s ease';
  el.focus();
}

const shakeStyle = document.createElement('style');
shakeStyle.textContent = `
  @keyframes shake {
    0%,100% { transform: translateX(0); }
    20%,60% { transform: translateX(-6px); }
    40%,80% { transform: translateX(6px); }
  }
`;
document.head.appendChild(shakeStyle);

// ─── Session events ───────────────────────────────────────────────────────────

socket.on('session-restored', ({ playerIndex, players, scores, phase }) => {
  hideBanner();

  state.playerIndex  = playerIndex;
  state.playerName   = players[playerIndex];
  state.opponentName = players[1 - playerIndex];

  // Restore HUD
  document.getElementById('hud-name0').textContent = players[0];
  document.getElementById('hud-name1').textContent = players[1];
  updateHud(scores);

  // If pregame, show the ready screen again (player must re-click ready)
  if (phase === 'pregame') {
    document.getElementById('players-vs').innerHTML = `
      <div class="player-chip" style="border-color:#a78bfa">${players[0]}</div>
      <div class="vs-text">VS</div>
      <div class="player-chip" style="border-color:#22d3ee">${players[1]}</div>
    `;
    const btn = document.getElementById('ready-btn');
    btn.disabled    = false;
    btn.textContent = 'מוכן! בואו נתחיל 🚀';
    document.getElementById('ready-status').textContent = '';
    showScreen('s-gamestart');
  }
  // For all other phases the subsequent resync event (round-start / generating / etc.)
  // will navigate to the correct screen automatically.
});

socket.on('session-not-found', () => {
  // Game no longer exists — clear saved data and let player start fresh
  localStorage.removeItem('bvn_game');
});

// Shown when we reconnect but had already submitted before the drop
socket.on('already-submitted', () => {
  const opName = state.opponentName || 'השחקן השני';
  document.getElementById('submitted-title').textContent  = 'ממשיכים מאיפה שעצרנו...';
  document.getElementById('waiting-for-text').textContent = `ממתין ל${opName}...`;
  showScreen('s-submitted');
});

// ─── Opponent connection events ───────────────────────────────────────────────

socket.on('opponent-temp-disconnect', () => {
  const opName = state.opponentName || 'השחקן השני';
  showBanner(`⏳ ${opName} התנתק. ממתין שיחזור (עד 45 שניות)...`);
});

socket.on('opponent-reconnected', () => {
  hideBanner();
});

// ─── Game events ──────────────────────────────────────────────────────────────

socket.on('game-created', ({ gameId }) => {
  state.gameId    = gameId;
  state.shareLink = `${location.origin}?game=${gameId}`;
  localStorage.setItem('bvn_game', gameId);
  document.getElementById('share-link-text').textContent = state.shareLink;
  showScreen('s-waiting');
});

socket.on('game-start', ({ players }) => {
  state.opponentName = players[1 - state.playerIndex];

  document.getElementById('hud-name0').textContent = players[0];
  document.getElementById('hud-name1').textContent = players[1];
  updateHud([0, 0], '');

  document.getElementById('players-vs').innerHTML = `
    <div class="player-chip" style="border-color:#a78bfa">${players[0]}</div>
    <div class="vs-text">VS</div>
    <div class="player-chip" style="border-color:#22d3ee">${players[1]}</div>
  `;

  const btn = document.getElementById('ready-btn');
  btn.disabled    = false;
  btn.textContent = 'מוכן! בואו נתחיל 🚀';
  document.getElementById('ready-status').textContent = '';

  showScreen('s-gamestart');
});

socket.on('round-start', ({ roundNumber, totalRounds, type, category }) => {
  document.getElementById('rephrase-warning').style.display = 'none';
  state.currentRound = roundNumber;

  document.getElementById('round-badge').textContent = `סיבוב ${roundNumber} מתוך ${totalRounds}`;
  updateHud(null, roundNumber);

  const spotlightWrap = document.getElementById('category-spotlight-wrap');
  const freePrompt    = document.getElementById('free-prompt');

  if (type === 'free') {
    spotlightWrap.style.display = 'none';
    freePrompt.style.display    = 'block';
  } else {
    spotlightWrap.style.display = '';
    freePrompt.style.display    = 'none';
    document.getElementById('category-label').textContent =
      type === 'different' ? 'הקטגוריה שלך:' : 'הקטגוריה:';
    document.getElementById('category-word').textContent = category;
  }

  const typeTag = document.getElementById('round-type-tag');
  if (type === 'different') {
    typeTag.textContent   = '🎲 קטגוריה אישית';
    typeTag.style.display = 'inline-block';
  } else if (type === 'free') {
    typeTag.textContent   = '🆓 חופשי';
    typeTag.style.display = 'inline-block';
  } else {
    typeTag.style.display = 'none';
  }

  const input = document.getElementById('answer-input');
  input.value    = '';
  input.disabled = false;
  document.getElementById('submit-btn').disabled = false;

  showScreen('s-round');
  setTimeout(() => input.focus(), 300);
  startAnswerTimer(20);
});

socket.on('opponent-answered', () => {
  document.getElementById('waiting-for-text').textContent = '✅ השחקן השני ענה! יוצרים תמונה...';
});

// ─── Generating ───────────────────────────────────────────────────────────────

// ─── Answer countdown timer ───────────────────────────────────────────────────

let _answerTimerInterval = null;

function startAnswerTimer(seconds) {
  clearInterval(_answerTimerInterval);
  let remaining = seconds;
  const countEl = document.getElementById('timer-count');
  const timerEl = document.getElementById('answer-timer');
  countEl.textContent = remaining;
  timerEl.className   = 'answer-timer';

  _answerTimerInterval = setInterval(() => {
    remaining--;
    countEl.textContent = remaining;
    if (remaining <= 5) timerEl.className = 'answer-timer timer-urgent';
    if (remaining <= 0) clearInterval(_answerTimerInterval);
  }, 1000);
}

function stopAnswerTimer() {
  clearInterval(_answerTimerInterval);
}

function resetGeneratingScreen() {
  document.getElementById('gen-title').textContent    = 'יוצרים את התמונה שלכם...';
  document.getElementById('gen-subtitle').textContent = 'הבינה המלאכותית עובדת קשה 🤖';
}

socket.on('generating', () => {
  stopAnswerTimer();
  resetGeneratingScreen();
  showScreen('s-generating');
});

socket.on('generation-retrying', ({ attempt, max }) => {
  document.getElementById('gen-subtitle').textContent = `ניסיון ${attempt + 1} מתוך ${max}... 🔄`;
});

socket.on('generation-failed', () => {
  document.getElementById('gen-title').textContent    = '😔 לא הצלחנו ליצור תמונה';
  document.getElementById('gen-subtitle').textContent = 'תנסו לנסח את התשובות מחדש...';
  setTimeout(() => {
    document.getElementById('rephrase-warning').style.display = 'block';
    const input = document.getElementById('answer-input');
    input.value    = '';
    input.disabled = false;
    document.getElementById('submit-btn').disabled = false;
    showScreen('s-round');
    resetGeneratingScreen();
    setTimeout(() => input.focus(), 300);
  }, 2500);
});

// ─── Round timeout ────────────────────────────────────────────────────────────

socket.on('round-timeout', (data) => {
  stopAnswerTimer();

  // Player cards: who answered, who didn't
  document.getElementById('timeout-players').innerHTML =
    data.players.map((p, i) => {
      const color = i === 0 ? '#a78bfa' : '#22d3ee';
      const icon  = p.timedOut ? '⏰ לא ענה בזמן' : '✅ ענה בזמן';
      const pts   = p.timedOut ? `<span class="timeout-pts-lost">−0</span>` : `<span class="timeout-pts-gained">+${2} נקודות!</span>`;
      return `
        <div class="timeout-player-card" style="border-top: 3px solid ${color}">
          <div class="player-result-name">${p.name}</div>
          <div class="timeout-status">${icon}</div>
          <div>${pts}</div>
        </div>
      `;
    }).join('');

  // Scores
  const [p0, p1] = data.players;
  document.getElementById('timeout-scores').innerHTML = `
    <div class="score-chip" style="border-color:#a78bfa">
      <span class="score-name">${p0.name}</span>
      <span class="score-val">${data.scores[0]}</span>
    </div>
    <div class="score-label">ניקוד</div>
    <div class="score-chip" style="border-color:#22d3ee">
      <span class="score-name">${p1.name}</span>
      <span class="score-val">${data.scores[1]}</span>
    </div>
  `;

  updateHud(data.scores, state.currentRound);

  const nextBtn = document.getElementById('timeout-next-btn');
  nextBtn.disabled    = false;
  nextBtn.textContent = data.roundNumber >= 10 ? '🏆 ראה מי ניצח!' : `סיבוב ${data.roundNumber + 1} ←`;
  if (data.roundNumber >= 10) nextBtn.classList.add('btn-winner');
  else nextBtn.classList.remove('btn-winner');

  showScreen('s-timeout');
});

// ─── Guess phase ──────────────────────────────────────────────────────────────

socket.on('guess-phase', ({ roundNumber, imageUrl, myAnswer }) => {
  document.getElementById('guess-round-badge').textContent   = `סיבוב ${roundNumber}`;
  document.getElementById('guess-img').src                   = imageUrl;
  document.getElementById('my-answer-reminder').textContent  = myAnswer;
  document.getElementById('opponent-name-guess').textContent = state.opponentName || 'השחקן השני';

  const input = document.getElementById('guess-input');
  input.value    = '';
  input.disabled = false;
  document.getElementById('guess-btn').disabled = false;

  showScreen('s-guessing');
  setTimeout(() => input.focus(), 300);
});

socket.on('opponent-guessed', () => {
  if (document.getElementById('s-submitted').classList.contains('active')) {
    document.getElementById('waiting-for-text').textContent = '✅ גם השחקן השני ניחש! מחשבים תוצאות...';
  }
});

// ─── Round result ─────────────────────────────────────────────────────────────

socket.on('round-result', (data) => {
  state.results.push(data);

  document.getElementById('result-round-badge').textContent = `סיבוב ${data.roundNumber}`;

  updateHud(data.scores);

  const img   = document.getElementById('result-img');
  const noImg = document.getElementById('result-no-img');
  if (data.imageUrl) {
    img.src             = data.imageUrl;
    img.style.display   = 'block';
    noImg.style.display = 'none';
    img.onclick = () => App.openLightbox(data.imageUrl);
  } else {
    img.style.display   = 'none';
    noImg.style.display = 'flex';
  }

  const myPts = data.pointsThisRound[state.playerIndex];
  const banner = document.getElementById('result-points-banner');
  banner.innerHTML = myPts > 0
    ? `<span class="pts-earned pts-correct">+${myPts} נקודות! ניחשת נכון 🎯</span>`
    : `<span class="pts-earned pts-wrong">לא ניחשת נכון הפעם 😅</span>`;

  document.getElementById('result-players').innerHTML =
    data.players.map((p, i) => {
      const color     = i === 0 ? '#a78bfa' : '#22d3ee';
      const guessIcon = p.guessedCorrectly ? '✅' : '❌';
      return `
        <div class="player-result-card" style="border-top: 3px solid ${color}">
          <div class="player-result-name">${p.name}</div>
          ${p.category ? `<div class="player-result-category">${p.category}</div>` : ''}
          <div class="player-result-answer">"${p.answer}"</div>
          <div class="player-result-guess">${guessIcon} ניחש: "${p.guess}"</div>
        </div>
        ${i === 0 ? '<div class="result-plus">+</div>' : ''}
      `;
    }).join('');

  const [p0, p1] = data.players;
  document.getElementById('result-total-scores').innerHTML = `
    <div class="score-chip" style="border-color:#a78bfa">
      <span class="score-name">${p0.name}</span>
      <span class="score-val">${data.scores[0]}</span>
    </div>
    <div class="score-label">ניקוד</div>
    <div class="score-chip" style="border-color:#22d3ee">
      <span class="score-name">${p1.name}</span>
      <span class="score-val">${data.scores[1]}</span>
    </div>
  `;

  const nextBtn = document.getElementById('next-btn');
  nextBtn.disabled = false;
  if (data.roundNumber >= 10) {
    nextBtn.textContent = '🏆 ראה מי ניצח!';
    nextBtn.classList.add('btn-winner');
  } else {
    nextBtn.textContent = `סיבוב ${data.roundNumber + 1} ←`;
    nextBtn.classList.remove('btn-winner');
  }

  showScreen('s-result');
});

// ─── Game over ────────────────────────────────────────────────────────────────

socket.on('game-over', ({ results, scores, players }) => {
  localStorage.removeItem('bvn_game');
  buildGallery(results.length ? results : state.results);

  const [s0, s1] = scores || [0, 0];
  const [n0, n1] = players || ['שחקן 1', 'שחקן 2'];

  let winnerText;
  if (s0 > s1)      winnerText = `🏆 ${n0} ניצח!`;
  else if (s1 > s0) winnerText = `🏆 ${n1} ניצח!`;
  else              winnerText = '🤝 תיקו!';

  document.getElementById('final-winner').textContent = winnerText;
  document.getElementById('final-scores-display').innerHTML = `
    <span class="final-score-chip" style="color:#a78bfa">${n0}: <strong>${s0}</strong></span>
    <span class="final-score-sep">|</span>
    <span class="final-score-chip" style="color:#22d3ee">${n1}: <strong>${s1}</strong></span>
  `;

  showScreen('s-gameover');
  launchFireworks();
});

// ─── Fatal disconnect (grace period expired) ──────────────────────────────────

socket.on('opponent-disconnected', () => {
  hideBanner();
  document.getElementById('error-msg').textContent = '😔 השחקן השני התנתק מהמשחק';
  showScreen('s-error');
});

socket.on('error', ({ msg }) => {
  document.getElementById('error-msg').textContent = msg;
  showScreen('s-error');
});

// ─── Fireworks ────────────────────────────────────────────────────────────────

function launchFireworks() {
  const container = document.getElementById('fireworks-container');
  container.innerHTML = '';

  const colors = ['#a78bfa', '#ec4899', '#22d3ee', '#fbbf24', '#34d399', '#f87171'];
  const BURSTS = 8;

  for (let b = 0; b < BURSTS; b++) {
    setTimeout(() => {
      const burst = document.createElement('div');
      burst.className    = 'firework-burst';
      burst.style.left   = `${15 + Math.random() * 70}%`;
      burst.style.top    = `${5  + Math.random() * 50}%`;
      container.appendChild(burst);

      const PARTICLES = 14;
      for (let p = 0; p < PARTICLES; p++) {
        const particle = document.createElement('div');
        particle.className = 'firework-particle';
        const color = colors[Math.floor(Math.random() * colors.length)];
        const dist  = 55 + Math.random() * 55;
        const angle = (p / PARTICLES) * 360;
        particle.style.cssText = `--color:${color};--angle:${angle}deg;--dist:${dist}px;`;
        burst.appendChild(particle);
      }

      setTimeout(() => burst.remove(), 1200);
    }, b * 500);
  }

  setTimeout(() => launchFireworksWave(container, colors, 5), BURSTS * 500 + 200);
}

function launchFireworksWave(container, colors, count) {
  for (let b = 0; b < count; b++) {
    setTimeout(() => {
      const burst = document.createElement('div');
      burst.className    = 'firework-burst';
      burst.style.left   = `${10 + Math.random() * 80}%`;
      burst.style.top    = `${10 + Math.random() * 40}%`;
      container.appendChild(burst);

      for (let p = 0; p < 10; p++) {
        const particle = document.createElement('div');
        particle.className = 'firework-particle';
        const color = colors[Math.floor(Math.random() * colors.length)];
        const dist  = 40 + Math.random() * 40;
        const angle = (p / 10) * 360;
        particle.style.cssText = `--color:${color};--angle:${angle}deg;--dist:${dist}px;`;
        burst.appendChild(particle);
      }

      setTimeout(() => burst.remove(), 1000);
    }, b * 350);
  }
}

// ─── Gallery builder ──────────────────────────────────────────────────────────

function buildGallery(results) {
  const gallery = document.getElementById('gallery');
  gallery.innerHTML = results.map(r => {
    const imgHtml = r.imageUrl
      ? `<img src="${r.imageUrl}" alt="סיבוב ${r.roundNumber}" loading="lazy"
              onclick="App.openLightbox('${r.imageUrl}')" />`
      : `<div class="gallery-no-img">אין תמונה</div>`;

    const playersHtml = r.players.map(p => `
      <div class="gallery-player">
        <strong>${p.name}</strong>
        ${p.category ? `<span class="gallery-cat">(${p.category})</span>` : ''}
        <span class="gallery-ans">"${p.answer}"</span>
      </div>
    `).join('');

    const typeLabel = r.type === 'same'
      ? `<span style="color:#a78bfa">${r.category}</span>`
      : r.type === 'different'
        ? `<span style="color:#22d3ee">קטגוריות שונות</span>`
        : `<span style="color:#34d399">חופשי</span>`;

    return `
      <div class="gallery-item">
        <div class="gallery-round">סיבוב ${r.roundNumber} · ${typeLabel}</div>
        ${imgHtml}
        <div class="gallery-info">${playersHtml}</div>
      </div>
    `;
  }).join('');
}
