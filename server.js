const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Site files normally live in public/, but also work when uploaded flat next to server.js.
const STATIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;
app.use(express.static(STATIC_DIR));
app.get('/healthz', (req, res) => res.send('ok'));
// Lists real clips dropped into sounds/ so the client can prefer them over synthesis.
app.get('/sounds-manifest', (req, res) => {
  fs.readdir(path.join(STATIC_DIR, 'sounds'), (err, files) => {
    res.json(err ? [] : files.filter((f) => /\.(mp3|wav|ogg)$/i.test(f)));
  });
});

const ALLOWED_MINUTES = [0, 1, 2, 3, 5, 10, 15, 30, 60];
const ROOM_TTL_MS = 30 * 60 * 1000;
const rooms = new Map();

const other = (c) => (c === 'w' ? 'b' : 'w');

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += chars[crypto.randomInt(chars.length)];
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return n || 'שחקן';
}

function createRoom({ minutes, increment, color }) {
  const base = minutes > 0 ? minutes * 60000 : null;
  const room = {
    code: makeCode(),
    chess: new Chess(),
    players: { w: null, b: null },
    creatorColor: color === 'w' || color === 'b' ? color : crypto.randomInt(2) ? 'w' : 'b',
    base,
    inc: base == null ? 0 : increment * 1000,
    clock: { w: base, b: base },
    turnStart: null,
    status: 'waiting', // waiting | playing | over
    winner: null,
    reason: null,
    drawOffer: null,
    rematch: new Set(),
    chat: [],
    emptySince: null,
  };
  rooms.set(room.code, room);
  return room;
}

function timeLeft(room, color) {
  let t = room.clock[color];
  if (t == null) return null;
  if (room.status === 'playing' && room.turnStart && room.chess.turn() === color) {
    t -= Date.now() - room.turnStart;
  }
  return Math.max(0, t);
}

function publicPlayer(p) {
  return p ? { name: p.name, connected: p.connected } : null;
}

function publicState(room) {
  const c = room.chess;
  const playing = room.status === 'playing';
  return {
    code: room.code,
    fen: c.fen(),
    turn: c.turn(),
    status: room.status,
    winner: room.winner,
    reason: room.reason,
    players: { w: publicPlayer(room.players.w), b: publicPlayer(room.players.b) },
    clocks: { w: timeLeft(room, 'w'), b: timeLeft(room, 'b') },
    running: playing && room.turnStart ? c.turn() : null,
    base: room.base,
    inc: room.inc,
    moves: c.history({ verbose: true }).map((m) => ({
      san: m.san, from: m.from, to: m.to, color: m.color, piece: m.piece, captured: m.captured || null,
    })),
    legal: playing
      ? c.moves({ verbose: true }).map((m) => ({ from: m.from, to: m.to, promotion: m.promotion || null }))
      : [],
    inCheck: c.inCheck(),
    drawOffer: room.drawOffer,
    rematch: [...room.rematch],
  };
}

function broadcast(room) {
  io.to(room.code).emit('state', publicState(room));
}

function endGame(room, winner, reason) {
  if (room.base != null && room.turnStart) {
    const t = room.chess.turn();
    room.clock[t] = Math.max(0, room.clock[t] - (Date.now() - room.turnStart));
  }
  room.turnStart = null;
  room.status = 'over';
  room.winner = winner;
  room.reason = reason;
  room.drawOffer = null;
  room.rematch.clear();
}

function onlyKing(chess, color) {
  return chess.board().flat().filter((p) => p && p.color === color).every((p) => p.type === 'k');
}

function flag(room, color) {
  room.clock[color] = 0;
  room.turnStart = null;
  const opp = other(color);
  // Flagging against a lone king is a draw.
  if (onlyKing(room.chess, opp)) endGame(room, null, 'timeout-draw');
  else endGame(room, opp, 'timeout');
}

function seatOf(room, socket) {
  if (!room) return null;
  return ['w', 'b'].find((c) => room.players[c] && room.players[c].socketId === socket.id) || null;
}

function detach(socket) {
  const room = rooms.get(socket.data.code);
  if (!room) return;
  for (const c of ['w', 'b']) {
    const p = room.players[c];
    if (p && p.socketId === socket.id) p.connected = false;
  }
  broadcast(room);
}

io.on('connection', (socket) => {
  socket.on('create', (opts = {}, cb) => {
    const minutes = ALLOWED_MINUTES.includes(Number(opts.minutes)) ? Number(opts.minutes) : 10;
    const increment = Math.min(30, Math.max(0, Math.floor(Number(opts.increment) || 0)));
    const room = createRoom({ minutes, increment, color: opts.color });
    if (typeof cb === 'function') cb({ code: room.code });
  });

  socket.on('join', ({ code, name, token } = {}) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return socket.emit('err', { code: 'notfound', msg: 'החדר לא נמצא או שפג תוקפו' });

    if (socket.data.code && socket.data.code !== code) {
      detach(socket);
      socket.leave(socket.data.code);
    }
    token = String(token || socket.id).slice(0, 64);
    name = cleanName(name);
    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;

    let color = ['w', 'b'].find((c) => room.players[c] && room.players[c].token === token) || null;
    if (color) {
      Object.assign(room.players[color], { socketId: socket.id, connected: true, name });
    } else {
      const { w, b } = room.players;
      const free = !w && !b ? room.creatorColor : !w ? 'w' : !b ? 'b' : null;
      if (free) {
        room.players[free] = { token, name, socketId: socket.id, connected: true };
        color = free;
      }
    }
    if (room.status === 'waiting' && room.players.w && room.players.b) room.status = 'playing';

    socket.emit('joined', { code, color, chat: room.chat });
    broadcast(room);
  });

  socket.on('leave', () => {
    detach(socket);
    if (socket.data.code) socket.leave(socket.data.code);
    socket.data.code = null;
  });

  socket.on('move', ({ from, to, promotion } = {}) => {
    const room = rooms.get(socket.data.code);
    const color = seatOf(room, socket);
    if (!room || room.status !== 'playing' || !color || room.chess.turn() !== color) return;

    if (room.base != null && room.turnStart && timeLeft(room, color) <= 0) {
      flag(room, color);
      return broadcast(room);
    }

    let mv;
    try {
      mv = room.chess.move({
        from: String(from), to: String(to),
        promotion: ['q', 'r', 'b', 'n'].includes(promotion) ? promotion : 'q',
      });
    } catch {
      return socket.emit('state', publicState(room)); // illegal: resync the client
    }

    if (room.base != null) {
      if (room.turnStart) room.clock[color] = room.clock[color] - (Date.now() - room.turnStart) + room.inc;
      // Each side's first move is free; clocks start after black's first move.
      room.turnStart = room.chess.history().length >= 2 ? Date.now() : null;
    }
    if (room.drawOffer && room.drawOffer !== color) room.drawOffer = null;

    const c = room.chess;
    if (c.isCheckmate()) endGame(room, color, 'checkmate');
    else if (c.isStalemate()) endGame(room, null, 'stalemate');
    else if (c.isInsufficientMaterial()) endGame(room, null, 'insufficient');
    else if (c.isThreefoldRepetition()) endGame(room, null, 'repetition');
    else if (c.isDraw()) endGame(room, null, 'fifty');

    io.to(room.code).emit('moved', {
      color, piece: mv.piece, captured: mv.captured || null, san: mv.san, check: c.inCheck(),
    });
    broadcast(room);
  });

  socket.on('resign', () => {
    const room = rooms.get(socket.data.code);
    const color = seatOf(room, socket);
    if (!color || room.status !== 'playing') return;
    endGame(room, other(color), 'resign');
    broadcast(room);
  });

  socket.on('draw', (action) => {
    const room = rooms.get(socket.data.code);
    const color = seatOf(room, socket);
    if (!color || room.status !== 'playing') return;
    const opp = other(color);
    if (action === 'offer') {
      if (room.drawOffer === opp) endGame(room, null, 'agreement');
      else room.drawOffer = color;
    } else if (action === 'accept' && room.drawOffer === opp) {
      endGame(room, null, 'agreement');
    } else if (action === 'decline' && room.drawOffer === opp) {
      room.drawOffer = null;
    }
    broadcast(room);
  });

  socket.on('rematch', () => {
    const room = rooms.get(socket.data.code);
    const color = seatOf(room, socket);
    if (!color || room.status !== 'over') return;
    room.rematch.add(color);
    if (room.rematch.size === 2) {
      const { w, b } = room.players;
      room.players = { w: b, b: w };
      room.chess = new Chess();
      room.clock = { w: room.base, b: room.base };
      room.turnStart = null;
      room.status = 'playing';
      room.winner = null;
      room.reason = null;
      room.drawOffer = null;
      room.rematch.clear();
      for (const c of ['w', 'b']) io.to(room.players[c].socketId).emit('seat', { color: c });
      io.to(room.code).emit('newgame');
    }
    broadcast(room);
  });

  socket.on('chat', (text) => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    text = String(text || '').trim().slice(0, 200);
    if (!text) return;
    const entry = { name: socket.data.name || 'צופה', color: seatOf(room, socket), text, ts: Date.now() };
    room.chat.push(entry);
    if (room.chat.length > 50) room.chat.shift();
    io.to(room.code).emit('chat', entry);
  });

  socket.on('disconnect', () => detach(socket));
});

// Flag checks.
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.status !== 'playing' || room.base == null || !room.turnStart) continue;
    const t = room.chess.turn();
    if (timeLeft(room, t) <= 0) {
      flag(room, t);
      broadcast(room);
    }
  }
}, 200);

// Drop rooms nobody has been connected to for a while.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const size = io.sockets.adapter.rooms.get(code)?.size || 0;
    if (size > 0) room.emptySince = null;
    else if (!room.emptySince) room.emptySince = now;
    else if (now - room.emptySince > ROOM_TTL_MS) rooms.delete(code);
  }
}, 60 * 1000);

server.listen(PORT, () => console.log(`Noisy chess listening on :${PORT}`));
