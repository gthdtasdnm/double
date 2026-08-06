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
// Beitritt über einen geteilten Link. Gesendet wird erst, wenn die Verbindung
// wirklich steht – vorher fiele die Nachricht lautlos unter den Tisch.
let pendingJoin = null;

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
    else if (pendingJoin) {
      send({ t: "join", roomId: pendingJoin, name: playerName() });
      pendingJoin = null;   // nur beim ersten Verbinden, nicht bei jedem Reconnect
    } else send({ t: "list" });
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
const NAME_KEY = "spiele_name";   // gemeinsam mit den anderen drei Spielen

// Sitzplatz-Tierchen. Gleiche Liste und gleiche Ableitung in allen vier
// Spielen, damit dieselbe Person überall dasselbe Zeichen bekommt.
const AVATARS = ["🦊", "🐙", "🦅", "🐺", "🦁", "🐉"];
const avatarFor = (id) =>
  AVATARS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATARS.length];

const nameInput = $("nameInput");
nameInput.value = localStorage.getItem(NAME_KEY) || localStorage.getItem("dbl_name") || "";
nameInput.addEventListener("input", () => localStorage.setItem(NAME_KEY, nameInput.value));

let visibility = "public";
for (const b of document.querySelectorAll("[data-vis]")) {
  b.onclick = () => {
    visibility = b.dataset.vis;
    document.querySelectorAll("[data-vis]").forEach((x) => x.classList.toggle("sel", x === b));
  };
}

function playerName() {
  const n = nameInput.value.trim();
  return n || `Spieler ${Math.floor(Math.random() * 90 + 10)}`;
}

$("createBtn").onclick = () => {
  send({ t: "create", name: playerName(), isPublic: visibility === "public" });
};

function joinByCode() {
  const code = $("codeInput").value.toUpperCase().trim();
  if (code.length !== 4) { $("codeInput").focus(); return toast("Der Code hat vier Zeichen."); }
  send({ t: "join", roomId: code, name: playerName() });
}
$("joinBtn").onclick = joinByCode;
$("codeInput").onkeydown = (e) => { if (e.key === "Enter") joinByCode(); };
nameInput.onkeydown = (e) => { if (e.key === "Enter") $("createBtn").click(); };

function renderRoomList(list) {
  const box = $("roomList");
  box.innerHTML = "";
  $("roomCount").textContent = list.length ? `(${list.length})` : "";
  if (!list.length) {
    box.innerHTML =
      '<div class="rooms-empty">Gerade ist kein Raum offen. Eröffne einen – ' +
      'er erscheint dann bei den anderen in der Liste.</div>';
    return;
  }
  for (const r of list) {
    const b = document.createElement("button");
    b.className = "roomrow";
    b.innerHTML = `
      <span class="roomrow-name">${esc(r.host)}</span>
      <span class="roomrow-meta">${r.players}/${r.max} · bis ${r.target}</span>
      <span class="roomrow-code">${r.id}</span>`;
    b.onclick = () => send({ t: "join", roomId: r.id, name: playerName() });
    box.appendChild(b);
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
$("leaveBtn").onclick = $("leaveBtn2").onclick = () => {
  send({ t: "leave" });
  clearSession();
  // Den Code aus der Adresse nehmen, sonst führt ein Neuladen wieder hinein.
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  showView("lobby");
};

$("readyBtn").onclick = () => send({ t: "ready", ready: !state.you.ready });
$("startBtn").onclick = () => send({ t: "start" });

$("copyBtn").onclick = async () => {
  if (!state?.room) return;
  // Gegen document.baseURI gebaut: funktioniert unter /double/ hinter dem
  // Reverse Proxy genauso wie lokal auf localhost:8000.
  const link = new URL("#" + state.room.id, document.baseURI).href;
  try {
    await navigator.clipboard.writeText(link);
    toast("Link kopiert – schick ihn rum.");
  } catch {
    // Ohne Zwischenablage (kein HTTPS, alter Browser) wenigstens den Code zeigen.
    toast(`Code: ${state.room.id}`);
  }
};
for (const b of $("targetGroup").children) {
  b.onclick = () => { if (state?.you.isHost) send({ t: "target", value: Number(b.dataset.v) }); };
}

function renderRoom(s) {
  $("roomTitle").textContent = s.room.name;
  $("roomCode").textContent = s.room.id;
  $("roomVis").textContent = s.room.isPublic
    ? "Öffentlich – steht in der Liste"
    : "Privat – nur mit Code";

  const box = $("playerList");
  box.innerHTML = "";
  for (let i = 0; i < s.room.maxPlayers; i++) {
    const p = s.players[i];
    const d = document.createElement("div");
    if (!p) {
      d.className = "seat empty";
      d.innerHTML = '<div class="av">🪑</div><div class="nm">frei</div><div class="st">wartet</div>';
    } else {
      d.className = "seat" + (p.ready || p.host ? " ready" : "") + (p.connected ? "" : " off");
      d.innerHTML = `
        <div class="av">${avatarFor(p.id)}</div>
        <div class="nm">${esc(p.name)}${p.id === s.you.id ? " (du)" : ""}</div>
        <div class="st">${!p.connected ? "weg" : p.host ? "startet" : p.ready ? "✓ bereit" : "wartet"}</div>
        ${p.host ? '<div class="host">HOST</div>' : ""}`;
    }
    box.appendChild(d);
  }

  const grp = $("targetGroup");
  grp.classList.toggle("locked", !s.you.isHost);
  for (const b of grp.children) b.classList.toggle("sel", Number(b.dataset.v) === s.room.target);

  const readyBtn = $("readyBtn");
  const startBtn = $("startBtn");
  readyBtn.style.display = s.you.isHost ? "none" : "";
  startBtn.style.display = s.you.isHost ? "" : "none";

  readyBtn.textContent = s.you.ready ? "Doch nicht bereit" : "Bereit";
  readyBtn.className = "btn " + (s.you.ready ? "ok" : "primary");

  // Wer gerade weg ist, zählt nicht mit – sonst blockiert er den Start.
  const here = s.players.filter((p) => p.connected);
  const missing = here.filter((p) => !p.ready && !p.host).map((p) => p.name);
  const tooFew = here.length < s.room.minPlayers;
  startBtn.disabled = tooFew || missing.length > 0;

  $("roomHint").textContent = tooFew
    ? `Es fehlt noch mindestens ${s.room.minPlayers - here.length} Spieler·in (${s.room.minPlayers}–${s.room.maxPlayers} können mitspielen).`
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

/* ------------------------------------------------------------------ */
/* Geteilter Link                                                      */
/* ------------------------------------------------------------------ */
// .../double/#AB3K – der Link ist die ganze Interaktion. Wer ihn öffnet, soll
// im Raum landen und nicht auf einer Startseite, auf der er den Raum erst
// suchen muss. Ist der Name schon bekannt, passiert das ohne einen Klick.
const shared = (location.hash || "").replace("#", "").toUpperCase().trim();
const sharedCode = /^[A-Z0-9]{4}$/.test(shared) ? shared : null;

/** Startseite auf „du bist eingeladen" umstellen: eine Frage, ein Knopf. */
function invitationMode() {
  if (!sharedCode) return;
  $("codeInput").value = sharedCode;
  const tag = document.querySelector("#view-lobby .tag");
  if (tag) tag.textContent = `Du bist eingeladen – Raum ${sharedCode}.`;

  // Den Knopf austauschen statt umbeschriften: sonst bliebe der alte
  // Klick-Handler dran und würde zusätzlich einen neuen Raum aufmachen.
  const alt = $("createBtn");
  const btn = alt.cloneNode(true);
  btn.textContent = "Beitreten";
  alt.replaceWith(btn);
  btn.onclick = () => send({ t: "join", roomId: sharedCode, name: playerName() });
}

// Name schon bekannt? Dann ohne Zwischenschritt hinein.
if (sharedCode && (localStorage.getItem(NAME_KEY) || "").trim()) pendingJoin = sharedCode;

invitationMode();
showView("lobby");
connect();
