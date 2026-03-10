require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── Constants ───────────────────────────────────────────────────────────────

const CATEGORIES = [
  'כלי תחבורה',
  'חיה',
  'פרי',
  'ירק',
  'מכשיר חשמלי',
  'פריט לבוש',
  'רהיט',
  'כלי נגינה',
  'כלי עבודה',
  'אוכל'
];

// English translations for better image generation prompts
const CAT_EN = {
  'כלי תחבורה': 'vehicle',
  'חיה': 'animal',
  'פרי': 'fruit',
  'ירק': 'vegetable',
  'מכשיר חשמלי': 'electrical appliance',
  'פריט לבוש': 'clothing item',
  'רהיט': 'furniture',
  'כלי נגינה': 'musical instrument',
  'כלי עבודה': 'tool',
  'אוכל': 'food'
};

const TOTAL_ROUNDS = 10;
const SAME_CAT_ROUNDS = 5; // rounds 1-5 share a category; rounds 6-10 each player gets their own

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

// Build the 10 rounds: first 5 share a category, last 5 each player gets a different one
function buildRounds() {
  const s1 = shuffle(CATEGORIES);
  const rounds = [];

  // Rounds 1-5: same category for both
  for (let i = 0; i < SAME_CAT_ROUNDS; i++) {
    rounds.push({ type: 'same', category: s1[i] });
  }

  // Rounds 6-10: different categories per player (need 10 slots; reuse shuffled pool)
  const s2 = shuffle(CATEGORIES);
  for (let i = 0; i < TOTAL_ROUNDS - SAME_CAT_ROUNDS; i++) {
    rounds.push({
      type: 'different',
      category0: s2[i * 2 % s2.length],
      category1: s2[(i * 2 + 1) % s2.length]
    });
  }

  return rounds;
}

// ─── Gemini image generation ──────────────────────────────────────────────────

async function generateImage(prompt) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash-exp',
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT']
    }
  });

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }]
  });

  const parts = result.response.candidates[0].content.parts;
  for (const part of parts) {
    if (part.inlineData) {
      return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
    }
  }
  throw new Error('No image in Gemini response');
}

// ─── Game state ───────────────────────────────────────────────────────────────

const games = {};

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  // Player 1 creates a game
  socket.on('create-game', ({ playerName }) => {
    const gameId = generateId();
    games[gameId] = {
      id: gameId,
      status: 'waiting',
      players: [{ id: socket.id, name: playerName.trim() }],
      rounds: buildRounds(),
      currentRound: 0,
      answers: {},    // answers[roundIndex][playerIndex] = string
      results: [],
      _advancing: false
    };

    socket.join(gameId);
    socket.data.gameId = gameId;
    socket.data.playerIndex = 0;

    socket.emit('game-created', { gameId, playerName: playerName.trim() });
  });

  // Player 2 joins
  socket.on('join-game', ({ gameId, playerName }) => {
    const id = (gameId || '').toUpperCase().trim();
    const game = games[id];

    if (!game)            return socket.emit('error', { msg: 'משחק לא נמצא. בדוק את הקישור.' });
    if (game.players.length >= 2) return socket.emit('error', { msg: 'המשחק כבר מלא.' });
    if (game.status !== 'waiting') return socket.emit('error', { msg: 'המשחק כבר התחיל.' });

    game.players.push({ id: socket.id, name: playerName.trim() });
    game.status = 'playing';

    socket.join(id);
    socket.data.gameId = id;
    socket.data.playerIndex = 1;

    io.to(id).emit('game-start', {
      players: game.players.map(p => p.name)
    });

    // Short dramatic pause before round 1
    setTimeout(() => startRound(id), 2500);
  });

  // Player submits their answer for the current round
  socket.on('submit-answer', ({ answer }) => {
    const { gameId, playerIndex } = socket.data;
    const game = games[gameId];
    if (!game || game.status !== 'playing') return;

    const ri = game.currentRound;
    if (!game.answers[ri]) game.answers[ri] = {};
    game.answers[ri][playerIndex] = (answer || '').trim();

    // Tell the other player their opponent has answered
    socket.to(gameId).emit('opponent-answered');

    // If both answered, generate the image
    const ans = game.answers[ri];
    if (ans[0] !== undefined && ans[1] !== undefined) {
      processRound(gameId);
    }
  });

  // Either player clicks "Next Round"
  socket.on('next-round', () => {
    const { gameId } = socket.data;
    const game = games[gameId];
    if (!game || game._advancing) return;

    game._advancing = true;
    game.currentRound++;

    if (game.currentRound >= TOTAL_ROUNDS) {
      game.status = 'finished';
      io.to(gameId).emit('game-over', { results: game.results });
    } else {
      startRound(gameId);
    }

    setTimeout(() => { game._advancing = false; }, 800);
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
      roundNumber,
      totalRounds: TOTAL_ROUNDS,
      type: 'same',
      category: round.category
    });
  } else {
    // Each player receives their own category privately
    getGameSockets(gameId).forEach((s, idx) => {
      if (!s) return;
      s.emit('round-start', {
        roundNumber,
        totalRounds: TOTAL_ROUNDS,
        type: 'different',
        category: idx === 0 ? round.category0 : round.category1
      });
    });
  }
}

async function processRound(gameId) {
  const game = games[gameId];
  const ri = game.currentRound;
  const round = game.rounds[ri];
  const ans = game.answers[ri];
  const [p0, p1] = game.players;

  io.to(gameId).emit('generating');

  let prompt;
  let resultData;

  if (round.type === 'same') {
    const catEn = CAT_EN[round.category] || round.category;
    prompt = `create a ${catEn} that combines "${ans[0]}" and "${ans[1]}", 3d pixar or disney style, vibrant colors, white background`;
    resultData = {
      roundNumber: ri + 1,
      type: 'same',
      category: round.category,
      players: [
        { name: p0.name, answer: ans[0] },
        { name: p1.name, answer: ans[1] }
      ]
    };
  } else {
    const cat0En = CAT_EN[round.category0] || round.category0;
    const cat1En = CAT_EN[round.category1] || round.category1;
    prompt = `create something completely new and creative that combines "${ans[0]}" (a ${cat0En}) and "${ans[1]}" (a ${cat1En}), 3d pixar or disney style, vibrant colors, white background`;
    resultData = {
      roundNumber: ri + 1,
      type: 'different',
      players: [
        { name: p0.name, answer: ans[0], category: round.category0 },
        { name: p1.name, answer: ans[1], category: round.category1 }
      ]
    };
  }

  try {
    resultData.imageUrl = await generateImage(prompt);
  } catch (err) {
    console.error(`[Round ${ri + 1}] Image generation failed:`, err.message);
    resultData.imageUrl = null;
  }

  game.results.push(resultData);
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
