// Double – Multiplayer-Symbolsuchspiel
// Start:  deno run --allow-net --allow-read server.js
//
// Zero-Dependency: HTTP + WebSockets kommen komplett aus der Deno-Runtime.

const PORT = Number(Deno.env.get("PORT") ?? 8000);
// Lokal 0.0.0.0, damit Mitspieler im WLAN direkt draufkommen. Hinter einem
// Reverse Proxy gehört HOST=127.0.0.1 gesetzt, sonst ist der Dienst unter
// Umgehung von Apache auch ohne HTTPS erreichbar.
const HOST = Deno.env.get("HOST") ?? "0.0.0.0";
const PUBLIC_DIR = new URL("./public/", import.meta.url);

// ---------------------------------------------------------------------------
// Kartendeck (endliche projektive Ebene der Ordnung 7)
// -> 57 Karten mit je 8 Symbolen, je zwei Karten teilen sich GENAU ein Symbol.
// Damit hat jeder Spieler jede Runde exakt eine Übereinstimmung mit der Mitte.
// ---------------------------------------------------------------------------
const ORDER = 7;
const SYMBOLS = [
  "🍎", "🍌", "🍇", "🍓", "🍒", "🍉", "🥑", "🥕", "🌽", "🍄",
  "🌰", "🥐", "🍔", "🍕", "🌮", "🍩", "🍪", "🎂", "🍭", "🍫",
  "☕", "🍺", "⚽", "🏀", "🏈", "🎾", "🎱", "🏓", "🥊", "🎯",
  "🎲", "🎸", "🎺", "🎻", "🥁", "🎨", "🎬", "🎧", "📱", "💡",
  "🔑", "🔒", "🔔", "🎁", "🧲", "⏰", "🛴", "🚗", "✈️", "🚀",
  "⛵", "🚲", "🌵", "🌻", "🌙", "⭐", "🔥",
];

function buildDeck(n) {
  const cards = [];
  const first = [];
  for (let i = 0; i <= n; i++) first.push(i);
  cards.push(first);

  for (let j = 1; j <= n; j++) {
    const card = [0];
    for (let k = 1; k <= n; k++) card.push(n + 1 + n * (j - 1) + (k - 1));
    cards.push(card);
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= n; j++) {
      const card = [i];
      for (let k = 1; k <= n; k++) {
        card.push(n + 1 + n * (k - 1) + ((i - 1) * (k - 1) + j - 1) % n);
      }
      cards.push(card);
    }
  }
  return cards;
}

const DECK = buildDeck(ORDER);

// Sanity-Check beim Start: je zwei Karten teilen sich genau ein Symbol.
(function verifyDeck() {
  for (let a = 0; a < DECK.length; a++) {
    for (let b = a + 1; b < DECK.length; b++) {
      const shared = DECK[a].filter((s) => DECK[b].includes(s));
      if (shared.length !== 1) {
        throw new Error(`Deck kaputt: Karten ${a}/${b} teilen ${shared.length} Symbole`);
      }
    }
  }
})();

// ---------------------------------------------------------------------------
// Layout: Symbole zufällig, überlappungsfrei, unterschiedlich groß & gedreht
// Koordinaten sind normalisiert: Kartenmitte (0,0), Kartenrand bei Radius 1.
// ---------------------------------------------------------------------------
function makeLayout(symbolIds) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const shrink = 1 - attempt * 0.012;
    const placed = [];
    let ok = true;

    for (const id of symbolIds) {
      const scale = (0.70 + Math.random() * 0.58) * shrink;
      const r = 0.205 * scale;
      let done = false;

      for (let k = 0; k < 3000; k++) {
        const ang = Math.random() * Math.PI * 2;
        const d = Math.sqrt(Math.random()) * (0.965 - r);
        const x = Math.cos(ang) * d;
        const y = Math.sin(ang) * d;
        let clash = false;
        for (const p of placed) {
          if (Math.hypot(x - p.x, y - p.y) < (r + p.r) * 1.015) { clash = true; break; }
        }
        if (!clash) {
          placed.push({ id, x, y, r, rot: Math.random() * 360 });
          done = true;
          break;
        }
      }
      if (!done) { ok = false; break; }
    }

    if (ok) {
      return placed.map((p) => ({
        s: p.id,
        x: +p.x.toFixed(4),
        y: +p.y.toFixed(4),
        r: +p.r.toFixed(4),
        rot: Math.round(p.rot),
      }));
    }
  }

  // Notfall-Layout: Ring (sollte praktisch nie erreicht werden)
  return symbolIds.map((id, i) => {
    const ang = (i / symbolIds.length) * Math.PI * 2;
    return {
      s: id,
      x: +(Math.cos(ang) * 0.6).toFixed(4),
      y: +(Math.sin(ang) * 0.6).toFixed(4),
      r: 0.17,
      rot: Math.round(Math.random() * 360),
    };
  });
}

// ---------------------------------------------------------------------------
// Räume & Spieler
// ---------------------------------------------------------------------------
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const COUNTDOWN_MS = 3200;
const ROUND_END_MS = 2800;
const PENALTY_MS = 1500;
const DISCONNECT_GRACE_MS = 10000;

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Set<Conn>} */
const conns = new Set();

const uid = () => crypto.randomUUID();
const shortId = () => Math.random().toString(36).slice(2, 7).toUpperCase();

function createRoom(name) {
  let id = shortId();
  while (rooms.has(id)) id = shortId();
  const room = {
    id,
    name: name || `Raum ${id}`,
    players: [],           // {id, name, ready, score, conn, connected, lockUntil, dropTimer}
    state: "lobby",        // lobby | countdown | playing | roundEnd | finished
    round: 0,
    target: 10,
    center: null,          // {ids, layout}
    hands: new Map(),      // pid -> {ids, layout, match}
    roundStart: 0,
    countdownEnd: 0,
    result: null,          // {winnerId, winnerName, match, ms}
    lastMiss: null,        // {name, at}
    timer: null,
    createdAt: Date.now(),
  };
  rooms.set(id, room);
  return room;
}

function roomSummary(r) {
  return {
    id: r.id,
    name: r.name,
    players: r.players.length,
    max: MAX_PLAYERS,
    host: r.players[0]?.name ?? "—",
    state: r.state,
    joinable: r.players.length < MAX_PLAYERS && (r.state === "lobby" || r.state === "finished"),
  };
}

function roomList() {
  return [...rooms.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(roomSummary);
}

function clearTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}

function destroyRoom(room) {
  clearTimer(room);
  rooms.delete(room.id);
  broadcastLobby();
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------
function snapshotFor(room, player) {
  const hand = room.hands.get(player.id);
  return {
    t: "state",
    room: {
      id: room.id,
      name: room.name,
      state: room.state,
      round: room.round,
      target: room.target,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
    },
    you: {
      id: player.id,
      name: player.name,
      isHost: room.players[0]?.id === player.id,
      ready: player.ready,
      lockUntil: player.lockUntil,
    },
    players: room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      ready: p.ready,
      host: i === 0,
      connected: p.connected,
    })),
    center: room.center ? { layout: room.center.layout } : null,
    hand: hand ? { layout: hand.layout } : null,
    countdownEnd: room.countdownEnd,
    roundStart: room.roundStart,
    result: room.result,
    lastMiss: room.lastMiss,
    now: Date.now(),
    symbols: SYMBOLS,
  };
}

function broadcastRoom(room) {
  for (const p of room.players) {
    if (p.conn && p.connected) send(p.conn, snapshotFor(room, p));
  }
  broadcastLobby();
}

function broadcastLobby() {
  const msg = { t: "rooms", rooms: roomList() };
  for (const c of conns) if (!c.roomId) send(c, msg);
}

function send(conn, obj) {
  try {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(obj));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Spiellogik
// ---------------------------------------------------------------------------
function everyoneReady(room) {
  const others = room.players.slice(1);
  return room.players.length >= MIN_PLAYERS && others.every((p) => p.ready && p.connected);
}

function startGame(room) {
  if (!everyoneReady(room)) return;
  clearTimer(room);
  for (const p of room.players) p.score = 0;
  room.round = 0;
  room.result = null;
  room.lastMiss = null;
  beginCountdown(room);
}

function beginCountdown(room) {
  room.state = "countdown";
  room.countdownEnd = Date.now() + COUNTDOWN_MS;
  room.center = null;
  room.hands.clear();
  broadcastRoom(room);
  clearTimer(room);
  room.timer = setTimeout(() => startRound(room), COUNTDOWN_MS);
}

function startRound(room) {
  if (room.players.length < MIN_PLAYERS) { abortToLobby(room); return; }

  const idx = [...DECK.keys()];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }

  const centerIds = shuffled(DECK[idx[0]]);
  room.center = { ids: centerIds, layout: makeLayout(centerIds) };
  room.hands.clear();

  room.players.forEach((p, i) => {
    const ids = shuffled(DECK[idx[i + 1]]);
    const match = ids.find((s) => centerIds.includes(s));
    room.hands.set(p.id, { ids, layout: makeLayout(ids), match });
    p.lockUntil = 0;
  });

  room.round += 1;
  room.state = "playing";
  room.result = null;
  room.lastMiss = null;
  room.roundStart = Date.now();
  broadcastRoom(room);
}

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function handlePick(room, player, symbolId) {
  if (room.state !== "playing") return;
  const hand = room.hands.get(player.id);
  if (!hand) return;
  const now = Date.now();
  if (player.lockUntil > now) return;
  if (!hand.ids.includes(symbolId)) return;

  if (symbolId === hand.match) {
    player.score += 1;
    room.state = "roundEnd";
    room.result = {
      winnerId: player.id,
      winnerName: player.name,
      match: hand.match,
      ms: now - room.roundStart,
    };
    clearTimer(room);
    if (player.score >= room.target) {
      room.state = "finished";
      broadcastRoom(room);
    } else {
      broadcastRoom(room);
      room.timer = setTimeout(() => startRound(room), ROUND_END_MS);
    }
  } else {
    player.lockUntil = now + PENALTY_MS;
    room.lastMiss = { id: player.id, name: player.name, at: now };
    broadcastRoom(room);
  }
}

function abortToLobby(room) {
  clearTimer(room);
  room.state = "lobby";
  room.center = null;
  room.hands.clear();
  room.result = null;
  room.round = 0;
  for (const p of room.players) { p.ready = false; p.lockUntil = 0; }
  broadcastRoom(room);
}

function resetToLobby(room) {
  clearTimer(room);
  room.state = "lobby";
  room.center = null;
  room.hands.clear();
  room.result = null;
  room.round = 0;
  for (const p of room.players) { p.ready = false; p.score = 0; p.lockUntil = 0; }
  broadcastRoom(room);
}

// ---------------------------------------------------------------------------
// Verbindungen
// ---------------------------------------------------------------------------
function leaveRoom(conn, { immediate = true } = {}) {
  const room = rooms.get(conn.roomId);
  conn.roomId = null;
  if (!room) return;
  const player = room.players.find((p) => p.id === conn.playerId);
  conn.playerId = null;
  if (!player) return;

  if (player.dropTimer) { clearTimeout(player.dropTimer); player.dropTimer = null; }
  room.players = room.players.filter((p) => p.id !== player.id);
  room.hands.delete(player.id);

  if (room.players.length === 0) { destroyRoom(room); return; }
  if (room.state !== "lobby" && room.state !== "finished" && room.players.length < MIN_PLAYERS) {
    abortToLobby(room);
    return;
  }
  if (immediate && (room.state === "countdown" || room.state === "playing")) {
    // Karte des verlassenden Spielers ist weg – Runde neu austeilen
    startRound(room);
    return;
  }
  broadcastRoom(room);
}

function handleMessage(conn, msg) {
  switch (msg.t) {
    case "list":
      send(conn, { t: "rooms", rooms: roomList() });
      break;

    case "create": {
      const name = String(msg.name ?? "").trim().slice(0, 16) || "Spieler";
      const roomName = String(msg.roomName ?? "").trim().slice(0, 24);
      const room = createRoom(roomName);
      joinRoom(conn, room, name);
      break;
    }

    case "join": {
      const room = rooms.get(String(msg.roomId ?? "").toUpperCase());
      if (!room) return send(conn, { t: "error", msg: "Raum existiert nicht (mehr)." });
      if (room.players.length >= MAX_PLAYERS) return send(conn, { t: "error", msg: "Raum ist voll." });
      if (room.state !== "lobby" && room.state !== "finished") {
        return send(conn, { t: "error", msg: "In diesem Raum läuft gerade ein Spiel." });
      }
      const name = String(msg.name ?? "").trim().slice(0, 16) || "Spieler";
      joinRoom(conn, room, name);
      break;
    }

    case "rejoin": {
      const room = rooms.get(String(msg.roomId ?? "").toUpperCase());
      const player = room?.players.find((p) => p.id === msg.pid);
      if (!room || !player) return send(conn, { t: "error", msg: "Sitzung abgelaufen.", fatal: true });
      if (player.dropTimer) { clearTimeout(player.dropTimer); player.dropTimer = null; }
      if (player.conn && player.conn !== conn) player.conn.roomId = null;
      player.conn = conn;
      player.connected = true;
      conn.roomId = room.id;
      conn.playerId = player.id;
      send(conn, { t: "joined", roomId: room.id, pid: player.id });
      broadcastRoom(room);
      break;
    }

    case "ready": {
      const { room, player } = ctx(conn);
      if (!room || !player) return;
      if (room.state !== "lobby" && room.state !== "finished") return;
      if (room.state === "finished") resetToLobby(room);
      player.ready = !!msg.ready;
      broadcastRoom(room);
      break;
    }

    case "target": {
      const { room, player } = ctx(conn);
      if (!room || !player || room.players[0]?.id !== player.id) return;
      const v = Number(msg.value);
      if ([5, 10, 15].includes(v)) { room.target = v; broadcastRoom(room); }
      break;
    }

    case "start": {
      const { room, player } = ctx(conn);
      if (!room || !player) return;
      if (room.players[0]?.id !== player.id) return;
      if (room.state === "finished") resetToLobby(room);
      if (room.state !== "lobby") return;
      if (!everyoneReady(room)) {
        return send(conn, { t: "error", msg: "Es sind noch nicht alle bereit." });
      }
      startGame(room);
      break;
    }

    case "pick": {
      const { room, player } = ctx(conn);
      if (!room || !player) return;
      handlePick(room, player, Number(msg.sym));
      break;
    }

    case "again": {
      const { room, player } = ctx(conn);
      if (!room || !player || room.players[0]?.id !== player.id) return;
      resetToLobby(room);
      break;
    }

    case "leave":
      leaveRoom(conn);
      send(conn, { t: "left" });
      send(conn, { t: "rooms", rooms: roomList() });
      break;
  }
}

function ctx(conn) {
  const room = rooms.get(conn.roomId);
  const player = room?.players.find((p) => p.id === conn.playerId);
  return { room, player };
}

function joinRoom(conn, room, name) {
  if (conn.roomId) leaveRoom(conn);
  const player = {
    id: uid(),
    name,
    ready: false,
    score: 0,
    conn,
    connected: true,
    lockUntil: 0,
    dropTimer: null,
  };
  room.players.push(player);
  conn.roomId = room.id;
  conn.playerId = player.id;
  send(conn, { t: "joined", roomId: room.id, pid: player.id });
  broadcastRoom(room);
}

function handleClose(conn) {
  conns.delete(conn);
  const { room, player } = ctx(conn);
  if (!room || !player) return;
  if (player.conn !== conn) return;
  player.connected = false;
  player.ready = false;
  broadcastRoom(room);
  player.dropTimer = setTimeout(() => {
    if (player.connected) return;
    conn.roomId = room.id;
    conn.playerId = player.id;
    leaveRoom(conn, { immediate: room.state === "playing" || room.state === "countdown" });
  }, DISCONNECT_GRACE_MS);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(pathname) {
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (rel.includes("..")) return new Response("Nope", { status: 400 });
  const url = new URL(rel, PUBLIC_DIR);
  if (!url.href.startsWith(PUBLIC_DIR.href)) return new Response("Nope", { status: 400 });
  try {
    const data = await Deno.readFile(url);
    const ext = rel.slice(rel.lastIndexOf("."));
    return new Response(data, {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-cache" },
    });
  } catch {
    return new Response("404 – nicht gefunden", { status: 404 });
  }
}

Deno.serve({ port: PORT, hostname: HOST, onListen: ({ port }) => {
  console.log(`\n  🎯  Double läuft:  http://localhost:${port}`);
  try {
    for (const net of Deno.networkInterfaces()) {
      if (net.family === "IPv4" && !net.address.startsWith("127.")) {
        console.log(`      im Netzwerk:   http://${net.address}:${port}`);
      }
    }
  } catch { /* ohne --allow-sys einfach überspringen */ }
  console.log("");
} }, (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/ws") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket erwartet", { status: 400 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    const conn = { ws: socket, roomId: null, playerId: null };
    socket.onopen = () => {
      conns.add(conn);
      send(conn, { t: "rooms", rooms: roomList() });
    };
    socket.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      try { handleMessage(conn, msg); } catch (err) { console.error("Fehler:", err); }
    };
    socket.onclose = () => handleClose(conn);
    socket.onerror = () => handleClose(conn);
    return response;
  }

  return serveStatic(url.pathname);
});
