/* ══════════════════════════════════════════════
   ביחד נוצרים — Client Logic
   ══════════════════════════════════════════════ */

const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  gameId:        null,
  playerName:    null,
  playerIndex:   null,
  opponentName:  null,
  currentRound:  0,
  shareLink:     null,
  results:       []   // accumulated locally for gallery
};

// ─── Screen management ────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── URL parsing ──────────────────────────────────────────────────────────────

const urlParams  = new URLSearchParams(window.location.search);
const urlGameId  = urlParams.get('game');

// On page load: show create or join screen
window.addEventListener('DOMContentLoaded', () => {
  if (urlGameId) {
    showScreen('s-join');
    // Pre-focus the name field
    setTimeout(() => document.getElementById('join-name').focus(), 100);
  } else {
    showScreen('s-create');
    setTimeout(() => document.getElementById('create-name').focus(), 100);
  }
});

// ─── Enter-key helpers ────────────────────────────────────────────────────────

document.getElementById('create-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') App.createGame();
});
document.getElementById('join-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') App.joinGame();
});
document.getElementById('answer-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') App.submitAnswer();
});

// ─── Public API (called from HTML) ───────────────────────────────────────────

const App = {

  createGame() {
    const name = document.getElementById('create-name').value.trim();
    if (!name) return shake('create-name');
    state.playerName   = name;
    state.playerIndex  = 0;
    socket.emit('create-game', { playerName: name });
  },

  joinGame() {
    const name = document.getElementById('join-name').value.trim();
    if (!name) return shake('join-name');
    state.playerName   = name;
    state.playerIndex  = 1;
    socket.emit('join-game', { gameId: urlGameId, playerName: name });
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

  submitAnswer() {
    const input  = document.getElementById('answer-input');
    const answer = input.value.trim();
    if (!answer) return shake('answer-input');

    document.getElementById('submit-btn').disabled = true;
    input.disabled = true;

    socket.emit('submit-answer', { answer });

    const opName = state.opponentName || 'השחקן השני';
    document.getElementById('waiting-for-text').textContent = `ממתין ל${opName}...`;
    showScreen('s-submitted');
  },

  nextRound() {
    socket.emit('next-round');
    const btn = document.getElementById('next-btn');
    btn.disabled     = true;
    btn.textContent  = 'ממתין...';
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
  el.offsetHeight; // reflow
  el.style.animation = 'shake 0.4s ease';
  el.focus();
}

// Inject shake keyframe once
const shakeStyle = document.createElement('style');
shakeStyle.textContent = `
  @keyframes shake {
    0%,100% { transform: translateX(0); }
    20%,60% { transform: translateX(-6px); }
    40%,80% { transform: translateX(6px); }
  }
`;
document.head.appendChild(shakeStyle);

// ─── Socket events ────────────────────────────────────────────────────────────

// Player 1: game was created on server
socket.on('game-created', ({ gameId }) => {
  state.gameId   = gameId;
  state.shareLink = `${location.origin}?game=${gameId}`;

  document.getElementById('share-link-text').textContent = state.shareLink;
  showScreen('s-waiting');
});

// Both players: game is starting
socket.on('game-start', ({ players }) => {
  // players[0] = creator, players[1] = joiner
  state.opponentName = players[1 - state.playerIndex];

  document.getElementById('players-vs').innerHTML = `
    <div class="player-chip">${players[0]}</div>
    <div class="vs-text">VS</div>
    <div class="player-chip">${players[1]}</div>
  `;

  showScreen('s-gamestart');
  // The server will fire 'round-start' after 2.5 s
});

// Round begins
socket.on('round-start', ({ roundNumber, totalRounds, type, category }) => {
  state.currentRound = roundNumber;

  document.getElementById('round-badge').textContent = `סיבוב ${roundNumber} מתוך ${totalRounds}`;
  document.getElementById('category-label').textContent =
    type === 'different' ? 'הקטגוריה שלך:' : 'הקטגוריה:';
  document.getElementById('category-word').textContent = category;

  const typeTag = document.getElementById('round-type-tag');
  if (type === 'different') {
    typeTag.textContent = '🎲 קטגוריה אישית';
    typeTag.style.display = 'inline-block';
  } else {
    typeTag.style.display = 'none';
  }

  // Reset answer input
  const input = document.getElementById('answer-input');
  input.value    = '';
  input.disabled = false;
  document.getElementById('submit-btn').disabled = false;

  showScreen('s-round');
  setTimeout(() => input.focus(), 300);
});

// Opponent has submitted their answer (we already submitted and are on s-submitted)
socket.on('opponent-answered', () => {
  const waitingText = document.getElementById('waiting-for-text');
  if (waitingText) {
    waitingText.textContent = '✅ השחקן השני ענה! יוצרים תמונה...';
  }
});

// Server is generating the image
socket.on('generating', () => {
  showScreen('s-generating');
});

// Round result received
socket.on('round-result', (data) => {
  state.results.push(data);

  // Round badge
  document.getElementById('result-round-badge').textContent = `סיבוב ${data.roundNumber}`;

  // Image
  const img      = document.getElementById('result-img');
  const noImg    = document.getElementById('result-no-img');

  if (data.imageUrl) {
    img.src            = data.imageUrl;
    img.style.display  = 'block';
    noImg.style.display = 'none';
    // Click to lightbox
    img.onclick = () => App.openLightbox(data.imageUrl);
  } else {
    img.style.display  = 'none';
    noImg.style.display = 'flex';
  }

  // Player cards
  document.getElementById('result-players').innerHTML =
    data.players.map((p, i) => {
      const color = i === 0 ? '#a78bfa' : '#22d3ee';
      return `
        <div class="player-result-card" style="border-top: 3px solid ${color}">
          <div class="player-result-name">${p.name}</div>
          ${p.category ? `<div class="player-result-category">${p.category}</div>` : ''}
          <div class="player-result-answer">"${p.answer}"</div>
        </div>
        ${i === 0 ? '<div class="result-plus">+</div>' : ''}
      `;
    }).join('');

  // Next button label
  const nextBtn = document.getElementById('next-btn');
  nextBtn.disabled    = false;
  nextBtn.textContent = data.roundNumber >= 10 ? '🎨 ראה את הגלריה' : `סיבוב ${data.roundNumber + 1} ←`;

  showScreen('s-result');
});

// Game over — show gallery
socket.on('game-over', ({ results }) => {
  buildGallery(results.length ? results : state.results);
  showScreen('s-gameover');
});

// Opponent disconnected
socket.on('opponent-disconnected', () => {
  document.getElementById('error-msg').textContent = '😔 השחקן השני התנתק מהמשחק';
  showScreen('s-error');
});

// Server error
socket.on('error', ({ msg }) => {
  document.getElementById('error-msg').textContent = msg;
  showScreen('s-error');
});

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
      : `<span style="color:#22d3ee">קטגוריות שונות</span>`;

    return `
      <div class="gallery-item">
        <div class="gallery-round">סיבוב ${r.roundNumber} · ${typeLabel}</div>
        ${imgHtml}
        <div class="gallery-info">${playersHtml}</div>
      </div>
    `;
  }).join('');
}
