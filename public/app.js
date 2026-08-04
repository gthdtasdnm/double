"use strict";

const $ = (id) => document.getElementById(id);
const views = {
  lobby: $("view-lobby"),
  room: $("view-room"),
  game: $("view-game"),
};

let ws = null;
let state = null;          // letzter Snapshot vom Server
let clockOffset = 0;       // serverZeit - clientZeit
let pid = sessionStorage.getItem("dbl_pid");
let roomId = sessionStorage.getItem("dbl_room");
let renderedCenterKey = "";
let renderedHandKey = "";
let lockTimer = null;
let reconnectTimer = null;

const serverNow = () => Date.now() + clockOffset;

/* ------------------------------------------------------------------ */
/* Verbindung                                                          */
/* ------------------------------------------------------------------ */
function connect() {
  // Relativ zum Basispfad, damit es auch hinter einem Reverse Proxy
  // unter einem Unterpfad läuft (z. B. https://host/double/ws).
  const url = new URL("ws", document.baseURI);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(url);

  ws.onopen = () => {
    if (pid && roomId) send({ t: "rejoin", roomId, pid });
    else send({ t: "list" });
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.t) {
      case "rooms":
        renderRoomList(msg.rooms);
        if (!roomId) showView("lobby");
        break;
      case "joined":
        roomId = msg.roomId;
        pid = msg.pid;
        sessionStorage.setItem("dbl_room", roomId);
        sessionStorage.setItem("dbl_pid", pid);
        break;
      case "state":
        applyState(msg);
        break;
      case "left":
        clearSession();
        showView("lobby");
        break;
      case "error":
        toast(msg.msg);
        if (msg.fatal) { clearSession(); showView("lobby"); send({ t: "list" }); }
        break;
    }
  };

  ws.onclose = () => {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1200);
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function clearSession() {
  roomId = null; pid = null; state = null;
  sessionStorage.removeItem("dbl_room");
  sessionStorage.removeItem("dbl_pid");
  renderedCenterKey = renderedHandKey = "";
}

function showView(name) {
  for (const [k, el] of Object.entries(views)) el.classList.toggle("active", k === name);
}

let toastTimer = null;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

/* ------------------------------------------------------------------ */
/* Lobby                                                               */
/* ------------------------------------------------------------------ */
const nameInput = $("nameInput");
nameInput.value = localStorage.getItem("dbl_name") || "";
nameInput.addEventListener("input", () => localStorage.setItem("dbl_name", nameInput.value));

function playerName() {
  const n = nameInput.value.trim();
  return n || `Spieler ${Math.floor(Math.random() * 90 + 10)}`;
}

$("createBtn").onclick = () => {
  send({ t: "create", name: playerName(), roomName: $("roomNameInput").value.trim() });
};

function renderRoomList(list) {
  const ul = $("roomList");
  ul.innerHTML = "";
  $("noRooms").style.display = list.length ? "none" : "block";
  $("roomCount").textContent = list.length ? `${list.length} Raum${list.length > 1 ? "e" : ""}` : "";

  for (const r of list) {
    const li = document.createElement("li");
    const running = r.state !== "lobby" && r.state !== "finished";
    li.innerHTML = `
      <div>
        <div class="rname">${esc(r.name)}</div>
        <div class="rmeta">Host: ${esc(r.host)} · ${r.players}/${r.max} Spieler${running ? " · läuft gerade" : ""}</div>
      </div>
      <div class="spacer"></div>`;
    const btn = document.createElement("button");
    btn.className = "btn primary small";
    btn.textContent = "Beitreten";
    btn.disabled = !r.joinable;
    if (r.players >= r.max) btn.textContent = "Voll";
    else if (running) btn.textContent = "Läuft";
    btn.onclick = () => send({ t: "join", roomId: r.id, name: playerName() });
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

/* ------------------------------------------------------------------ */
/* State-Verteilung                                                    */
/* ------------------------------------------------------------------ */
function applyState(s) {
  clockOffset = s.now - Date.now();
  const prev = state;
  state = s;

  if (s.room.state === "lobby") {
    clearInterval(bannerTicker);
    renderRoom(s);
    showView("room");
  } else {
    renderGame(s, prev);
    showView("game");
  }
}

/* ------------------------------------------------------------------ */
/* Warteraum                                                           */
/* ------------------------------------------------------------------ */
$("leaveBtn").onclick = $("leaveBtn2").onclick = () => { send({ t: "leave" }); clearSession(); showView("lobby"); };

$("readyBtn").onclick = () => send({ t: "ready", ready: !state.you.ready });
$("startBtn").onclick = () => send({ t: "start" });
for (const b of $("targetGroup").children) {
  b.onclick = () => { if (state?.you.isHost) send({ t: "target", value: Number(b.dataset.v) }); };
}

function renderRoom(s) {
  $("roomTitle").textContent = s.room.name;
  $("roomCode").textContent = s.room.id;

  const ul = $("playerList");
  ul.innerHTML = "";
  s.players.forEach((p) => {
    const li = document.createElement("li");
    li.className = (p.ready || p.host ? "ready " : "") + (p.id === s.you.id ? "me" : "");
    li.innerHTML = `<span class="dot"></span><span>${esc(p.name)}</span>
      ${p.host ? '<span class="tag host">Host</span>' : (p.ready ? '<span class="tag ready">Bereit</span>' : '<span class="tag">wartet</span>')}
      ${p.connected ? "" : '<span class="tag">offline</span>'}
      <div class="spacer" style="flex:1"></div>`;
    ul.appendChild(li);
  });
  for (let i = s.players.length; i < s.room.maxPlayers; i++) {
    const li = document.createElement("li");
    li.style.opacity = ".4";
    li.innerHTML = '<span class="dot"></span><span>freier Platz</span>';
    ul.appendChild(li);
  }

  const grp = $("targetGroup");
  grp.classList.toggle("locked", !s.you.isHost);
  for (const b of grp.children) b.classList.toggle("on", Number(b.dataset.v) === s.room.target);

  const readyBtn = $("readyBtn");
  const startBtn = $("startBtn");
  readyBtn.style.display = s.you.isHost ? "none" : "";
  startBtn.style.display = s.you.isHost ? "" : "none";

  readyBtn.textContent = s.you.ready ? "Doch nicht bereit" : "Bereit";
  readyBtn.className = "btn " + (s.you.ready ? "ok" : "primary");

  const others = s.players.slice(1);
  const missing = others.filter((p) => !p.ready).map((p) => p.name);
  const tooFew = s.players.length < s.room.minPlayers;
  startBtn.disabled = tooFew || missing.length > 0;

  $("roomHint").textContent = tooFew
    ? `Es fehlt noch mindestens ${s.room.minPlayers - s.players.length} Spieler·in (${s.room.minPlayers}–${s.room.maxPlayers} können mitspielen).`
    : missing.length
      ? (s.you.isHost ? `Noch nicht bereit: ${missing.join(", ")}` : "Warte darauf, dass alle bereit sind …")
      : (s.you.isHost ? "Alle bereit – du kannst starten!" : "Alle bereit – der Host startet gleich.");
}

/* ------------------------------------------------------------------ */
/* Spiel                                                               */
/* ------------------------------------------------------------------ */
const centerCard = $("centerCard");
const playerCard = $("playerCard");

playerCard.addEventListener("click", (e) => {
  const el = e.target.closest(".sym");
  if (!el || !state || state.room.state !== "playing") return;
  if (serverNow() < state.you.lockUntil) return;
  send({ t: "pick", sym: Number(el.dataset.sym) });
});

function cardKey(layout) {
  return layout.map((l) => `${l.s},${l.x},${l.rot}`).join("|");
}

function renderCard(el, layout, symbols) {
  for (const n of [...el.querySelectorAll(".sym")]) n.remove();
  const frag = document.createDocumentFragment();
  for (const it of layout) {
    const d = document.createElement("div");
    d.className = "sym";
    const dia = it.r * 100; // Symboldurchmesser in % der Kartenbreite
    d.style.left = `${(0.5 + it.x / 2) * 100}%`;
    d.style.top = `${(0.5 + it.y / 2) * 100}%`;
    d.style.width = `${dia}cqw`;
    d.style.height = `${dia}cqw`;
    d.style.fontSize = `${dia * 0.8}cqw`;
    d.style.setProperty("--rot", `${it.rot}deg`);
    d.dataset.sym = it.s;
    d.textContent = symbols[it.s];
    frag.appendChild(d);
  }
  el.appendChild(frag);
}

function renderGame(s, prev) {
  // Scoreboard
  const sb = $("scoreboard");
  const max = Math.max(...s.players.map((p) => p.score), 0);
  sb.innerHTML = "";
  for (const p of s.players) {
    const d = document.createElement("div");
    d.className = "sb" + (p.id === s.you.id ? " me" : "") + (p.score === max && max > 0 ? " lead" : "") + (p.connected ? "" : " off");
    d.innerHTML = `<span>${esc(p.name)}</span><b>${p.score}</b>`;
    sb.appendChild(d);
  }
  $("roundInfo").textContent = `Runde ${s.room.round} · bis ${s.room.target}`;

  // Karten
  if (s.center) {
    const k = cardKey(s.center.layout);
    if (k !== renderedCenterKey) { renderCard(centerCard, s.center.layout, s.symbols); renderedCenterKey = k; }
  }
  if (s.hand) {
    const k = cardKey(s.hand.layout);
    if (k !== renderedHandKey) { renderCard(playerCard, s.hand.layout, s.symbols); renderedHandKey = k; }
  }

  // Fehlklick-Sperre
  const lockLeft = s.you.lockUntil - serverNow();
  playerCard.classList.toggle("locked", lockLeft > 0);
  clearTimeout(lockTimer);
  if (lockLeft > 0) {
    lockTimer = setTimeout(() => {
      playerCard.classList.remove("locked");
      if (state && state.room.state === "playing") renderBanner(state);
    }, lockLeft);
    if (!prev || prev.lastMiss?.at !== s.lastMiss?.at) {
      if (s.lastMiss && s.lastMiss.id === s.you.id) {
        playerCard.classList.remove("shake");
        void playerCard.offsetWidth;
        playerCard.classList.add("shake");
        beep(160, 0.18, "sawtooth");
      }
    }
  }

  // Treffer-Hervorhebung
  if (s.room.state === "roundEnd" || s.room.state === "finished") {
    if (!prev || prev.room.state === "playing") {
      highlight(s.result?.match);
      if (s.result) beep(s.result.winnerId === s.you.id ? 880 : 420, 0.14);
    }
  }

  renderBanner(s, prev);
}

function highlight(sym) {
  if (sym == null) return;
  for (const el of document.querySelectorAll(`.sym[data-sym="${sym}"]`)) {
    el.classList.remove("hit");
    void el.offsetWidth;
    el.classList.add("hit");
  }
}

let bannerTicker = null;
function renderBanner(s, prev) {
  const b = $("banner");
  clearInterval(bannerTicker);

  if (s.room.state === "countdown") {
    let shown = null;
    const tick = () => {
      const left = Math.ceil((s.countdownEnd - serverNow()) / 1000);
      const label = left > 0 ? String(left) : "Los!";
      if (label === shown) return;   // sonst startet die pop-Animation 10×/s neu
      shown = label;
      b.innerHTML = left > 0 ? `<span class="big">${label}</span>` : `<span class="big win">${label}</span>`;
    };
    tick();
    bannerTicker = setInterval(tick, 100);
    return;
  }

  if (s.room.state === "playing") {
    const missMine = s.lastMiss && s.lastMiss.id === s.you.id && serverNow() < s.you.lockUntil;
    b.innerHTML = missMine
      ? '<span style="color:var(--danger)">Falsch – kurz gesperrt …</span>'
      : "Welches Symbol liegt auf beiden Karten?";
    return;
  }

  if (s.room.state === "roundEnd") {
    const mine = s.result?.winnerId === s.you.id;
    const secs = (s.result?.ms / 1000).toFixed(2);
    b.innerHTML = mine
      ? `<span class="win">Punkt für dich! ${s.symbols[s.result.match]} in ${secs}&nbsp;s</span>`
      : `<span class="lose">${esc(s.result?.winnerName ?? "?")} war schneller – ${s.symbols[s.result.match]} in ${secs}&nbsp;s</span>`;
    return;
  }

  if (s.room.state === "finished") {
    const winner = [...s.players].sort((a, b2) => b2.score - a.score)[0];
    const mine = winner?.id === s.you.id;
    b.innerHTML = `<span class="${mine ? "win" : "lose"}">${mine ? "🏆 Du gewinnst!" : `🏆 ${esc(winner?.name ?? "?")} gewinnt!`}</span>`;
    if (s.you.isHost) {
      const btn = document.createElement("button");
      btn.className = "btn primary small";
      btn.textContent = "Zurück in den Warteraum";
      btn.onclick = () => send({ t: "again" });
      b.appendChild(btn);
    } else {
      const span = document.createElement("span");
      span.className = "muted";
      span.style.marginLeft = "12px";
      span.textContent = "Der Host startet gleich eine neue Partie.";
      b.appendChild(span);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Kleine Sounds                                                       */
/* ------------------------------------------------------------------ */
let audioCtx = null;
function beep(freq, dur, type = "sine") {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.14, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch { /* egal */ }
}

showView("lobby");
connect();
