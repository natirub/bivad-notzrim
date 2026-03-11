require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenAI } = require('@google/genai');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ─── Constants ───────────────────────────────────────────────────────────────

const CATEGORIES = [
  'כלי תחבורה', 'חיה', 'פרי', 'ירק', 'מכשיר חשמלי',
  'פריט לבוש', 'רהיט', 'כלי נגינה', 'כלי עבודה', 'אוכל'
];

const CAT_EN = {
  'כלי תחבורה': 'vehicle',
  'חיה':        'animal',
  'פרי':        'fruit',
  'ירק':        'vegetable',
  'מכשיר חשמלי':'electrical appliance',
  'פריט לבוש':  'clothing item',
  'רהיט':       'furniture',
  'כלי נגינה':  'musical instrument',
  'כלי עבודה':  'tool',
  'אוכל':       'food'
};

const TOTAL_ROUNDS    = 10;
const SAME_CAT_ROUNDS = 3;   // rounds 1-3: same category
const DIFF_CAT_ROUNDS = 3;   // rounds 4-6: different category per player
                              // rounds 7-10: free (no category)
const GUESS_POINTS    = 5;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function buildRounds() {
  const s1 = shuffle(CATEGORIES);
  const rounds = [];

  // Rounds 1-3: same category
  for (let i = 0; i < SAME_CAT_ROUNDS; i++) {
    rounds.push({ type: 'same', category: s1[i] });
  }

  // Rounds 4-6: different category per player
  const s2 = shuffle(CATEGORIES);
  for (let i = 0; i < DIFF_CAT_ROUNDS; i++) {
    rounds.push({
      type: 'different',
      category0: s2[(i * 2)     % s2.length],
      category1: s2[(i * 2 + 1) % s2.length]
    });
  }

  // Rounds 7-10: free
  const freeRounds = TOTAL_ROUNDS - SAME_CAT_ROUNDS - DIFF_CAT_ROUNDS;
  for (let i = 0; i < freeRounds; i++) {
    rounds.push({ type: 'free' });
  }

  return rounds;
}

// ─── Gemini image generation ──────────────────────────────────────────────────

const API_TIMEOUT_MS = 30_000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Gemini timeout after ${ms}ms`)), ms)
    )
  ]);
}

async function generateImage(prompt, gameId) {
  const MAX_ATTEMPTS = 2;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await withTimeout(
        genAI.models.generateContent({
          model: 'gemini-3.1-flash-image-preview',
          contents: prompt,
          config: { responseModalities: ['TEXT', 'IMAGE'] }
        }),
        API_TIMEOUT_MS
      );

      for (const part of result.candidates[0].content.parts) {
        if (part.inlineData) {
          return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        }
      }
      lastErr = new Error('No image in Gemini response');
    } catch (err) {
      lastErr = err;
    }

    if (attempt < MAX_ATTEMPTS) {
      console.warn(`[generateImage] Attempt ${attempt} failed: ${lastErr.message}. Retrying...`);
      io.to(gameId).emit('generation-retrying', { attempt, max: MAX_ATTEMPTS });
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  throw lastErr;
}

// ─── Game state ───────────────────────────────────────────────────────────────

const games = {};

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('create-game', ({ playerName }) => {
    const gameId = generateId();
    games[gameId] = {
      id: gameId,
      status: 'waiting',
      players: [{ id: socket.id, name: playerName.trim() }],
      rounds: buildRounds(),
      currentRound: 0,
      answers: {},
      guesses: {},
      scores: [0, 0],
      results: [],
      _advancing: false,
      _generating: false,
      _pendingResult: null,
      _readyCount: 0
    };

    socket.join(gameId);
    socket.data.gameId = gameId;
    socket.data.playerIndex = 0;

    socket.emit('game-created', { gameId, playerName: playerName.trim() });
  });

  socket.on('join-game', ({ gameId, playerName }) => {
    const id = (gameId || '').toUpperCase().trim();
    const game = games[id];

    if (!game)                  return socket.emit('error', { msg: 'משחק לא נמצא. בדוק את הקישור.' });
    if (game.players.length >= 2) return socket.emit('error', { msg: 'המשחק כבר מלא.' });
    if (game.status !== 'waiting') return socket.emit('error', { msg: 'המשחק כבר התחיל.' });

    game.players.push({ id: socket.id, name: playerName.trim() });
    game.status = 'playing';

    socket.join(id);
    socket.data.gameId = id;
    socket.data.playerIndex = 1;

    io.to(id).emit('game-start', { players: game.players.map(p => p.name) });
    // Wait for both players to click "ready" before starting round 1
  });

  socket.on('player-ready', () => {
    const { gameId } = socket.data;
    const game = games[gameId];
    if (!game || game.status !== 'playing') return;
    game._readyCount++;
    if (game._readyCount >= 2) {
      startRound(gameId);
    }
  });

  socket.on('submit-answer', ({ answer }) => {
    const { gameId, playerIndex } = socket.data;
    const game = games[gameId];
    if (!game || game.status !== 'playing') return;

    const ri = game.currentRound;
    if (!game.answers[ri]) game.answers[ri] = {};
    game.answers[ri][playerIndex] = (answer || '').trim();

    socket.to(gameId).emit('opponent-answered');

    const ans = game.answers[ri];
    if (ans[0] !== undefined && ans[1] !== undefined) {
      processRound(gameId);
    }
  });

  socket.on('submit-guess', ({ guess }) => {
    const { gameId, playerIndex } = socket.data;
    const game = games[gameId];
    if (!game || game.status !== 'playing') return;

    const ri = game.currentRound;
    if (!game.guesses[ri]) game.guesses[ri] = {};
    game.guesses[ri][playerIndex] = (guess || '').trim();

    socket.to(gameId).emit('opponent-guessed');

    const g = game.guesses[ri];
    if (g[0] !== undefined && g[1] !== undefined) {
      resolveGuesses(gameId);
    }
  });

  socket.on('next-round', () => {
    const { gameId } = socket.data;
    const game = games[gameId];
    if (!game || game._advancing) return;

    game._advancing = true;
    game.currentRound++;

    if (game.currentRound >= TOTAL_ROUNDS) {
      game.status = 'finished';
      io.to(gameId).emit('game-over', {
        results: game.results,
        scores:  game.scores,
        players: game.players.map(p => p.name)
      });
    } else {
      startRound(gameId);
    }

    setTimeout(() => { game._advancing = false; }, 800);
  });

  socket.on('retry-generate', () => {
    const { gameId } = socket.data;
    const game = games[gameId];
    if (!game || game.status !== 'playing') return;
    const ri = game.currentRound;
    const ans = game.answers[ri];
    if (!ans || ans[0] === undefined || ans[1] === undefined) return;
    io.to(gameId).emit('generating');
    processRound(gameId);
  });

  socket.on('disconnect', () => {
    const { gameId } = socket.data;
    if (!gameId || !games[gameId]) return;
    socket.to(gameId).emit('opponent-disconnected');
  });
});

// ─── Round logic ──────────────────────────────────────────────────────────────

function startRound(gameId) {
  const game = games[gameId];
  const round = game.rounds[game.currentRound];
  const roundNumber = game.currentRound + 1;

  if (round.type === 'same') {
    io.to(gameId).emit('round-start', {
      roundNumber, totalRounds: TOTAL_ROUNDS,
      type: 'same', category: round.category
    });
  } else if (round.type === 'different') {
    getGameSockets(gameId).forEach((s, idx) => {
      if (!s) return;
      s.emit('round-start', {
        roundNumber, totalRounds: TOTAL_ROUNDS,
        type: 'different',
        category: idx === 0 ? round.category0 : round.category1
      });
    });
  } else {
    // free round
    io.to(gameId).emit('round-start', {
      roundNumber, totalRounds: TOTAL_ROUNDS,
      type: 'free'
    });
  }
}

async function processRound(gameId) {
  const game = games[gameId];
  if (game._generating) return;
  game._generating = true;

  const ri    = game.currentRound;
  const round = game.rounds[ri];
  const ans   = game.answers[ri];
  const [p0, p1] = game.players;

  io.to(gameId).emit('generating');

  let prompt;
  let resultData;

  if (round.type === 'same') {
    const catEn = CAT_EN[round.category] || round.category;
    prompt = `create a brand new and single ${catEn} that assembles "${ans[0]}" and "${ans[1]}" into one new thing, realistic, 3d animated style, vibrant colors, white background, and no text`;
    resultData = {
      roundNumber: ri + 1, type: 'same', category: round.category,
      players: [
        { name: p0.name, answer: ans[0] },
        { name: p1.name, answer: ans[1] }
      ]
    };
  } else if (round.type === 'different') {
    prompt = `create a single something completely new and creative that assembles "${ans[0]}" and "${ans[1]}", 3d animated style, vibrant colors, white background and no text`;
    resultData = {
      roundNumber: ri + 1, type: 'different',
      players: [
        { name: p0.name, answer: ans[0], category: round.category0 },
        { name: p1.name, answer: ans[1], category: round.category1 }
      ]
    };
  } else {
    // free
    prompt = `create a single something completely new and creative that assembles "${ans[0]}" and "${ans[1]}", 3d animated style, vibrant colors, white background and no text`;
    resultData = {
      roundNumber: ri + 1, type: 'free',
      players: [
        { name: p0.name, answer: ans[0] },
        { name: p1.name, answer: ans[1] }
      ]
    };
  }

  try {
    resultData.imageUrl = await generateImage(prompt, gameId);
  } catch (err) {
    console.error(`[Round ${ri + 1}] All attempts failed:`, err.message);
    game._generating = false;
    game.answers[ri] = {};
    io.to(gameId).emit('generation-failed', { roundNumber: ri + 1 });
    return;
  }

  game._generating = false;
  game._pendingResult = resultData;

  // Send each player into guess phase with the image + their own answer as reminder
  const sockets = getGameSockets(gameId);
  sockets.forEach((s, idx) => {
    if (!s) return;
    s.emit('guess-phase', {
      roundNumber: ri + 1,
      imageUrl:    resultData.imageUrl,
      myAnswer:    ans[idx]
    });
  });
}

function resolveGuesses(gameId) {
  const game = games[gameId];
  const ri   = game.currentRound;
  const ans  = game.answers[ri];
  const g    = game.guesses[ri];

  const norm = s => (s || '').trim().toLowerCase();
  const correct0 = norm(g[0]) === norm(ans[1]); // p0 guesses p1's answer
  const correct1 = norm(g[1]) === norm(ans[0]); // p1 guesses p0's answer

  if (correct0) game.scores[0] += GUESS_POINTS;
  if (correct1) game.scores[1] += GUESS_POINTS;

  const resultData = game._pendingResult;
  resultData.players[0].guessedCorrectly = correct0;
  resultData.players[0].guess = g[0];
  resultData.players[1].guessedCorrectly = correct1;
  resultData.players[1].guess = g[1];
  resultData.scores          = [...game.scores];
  resultData.pointsThisRound = [correct0 ? GUESS_POINTS : 0, correct1 ? GUESS_POINTS : 0];

  game.results.push(resultData);
  game._pendingResult = null;
  io.to(gameId).emit('round-result', resultData);
}

// ─── Socket helper ────────────────────────────────────────────────────────────

function getGameSockets(gameId) {
  const out = [null, null];
  const room = io.sockets.adapter.rooms.get(gameId);
  if (!room) return out;
  for (const sid of room) {
    const s = io.sockets.sockets.get(sid);
    if (s && s.data.playerIndex !== undefined) out[s.data.playerIndex] = s;
  }
  return out;
}

// ─── Serve static files ───────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 Game server → http://localhost:${PORT}`));
