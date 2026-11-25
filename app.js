// FaceClash 2.0 frontend. All data lives on the server (api.php + SQLite).
let ROUNDS = 10; // replaced by the admin's "Rounds per game" setting on load
const POLL_MS = 3000;

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(action, body) {
  const res = await fetch(`api.php?action=${action}`, body === undefined
    ? { credentials: "same-origin" }
    : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: "Bad response from server" }));
  if (!res.ok) throw Object.assign(new Error(data.error || "Request failed"), { status: res.status });
  return data;
}

function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function tierChip(t, cls = "") {
  return el("span", { className: `tier-chip t-${t.key} ${cls}`, textContent: `${t.icon} ${t.label}` });
}

function preload(src) {
  return new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = src; });
}

// ---------------- Voting ----------------
const cards = [$("#left"), $("#right")];
let pair = null;
let round = 0;
let busy = false;
let picks = [];

function setCard(card, p) {
  card.classList.remove("won", "lost");
  card.querySelector(".delta").className = "delta";
  card.querySelector("img").src = p.img;
  card.querySelector("img").alt = p.name;
  card.querySelector(".name").textContent = p.name;
}

async function loadPair() {
  busy = true;
  cards.forEach((c) => { c.disabled = true; c.classList.add("loading"); });
  try {
    const data = await api("pair");
    await Promise.all(data.pair.map((p) => preload(p.img)));
    pair = data.pair;
    pair.forEach((p, i) => setCard(cards[i], p));
  } catch (e) {
    toast(e.message);
  } finally {
    cards.forEach((c) => { c.disabled = false; c.classList.remove("loading"); });
    busy = false;
  }
}

function updateProgress() {
  $("#round").textContent = Math.min(round + 1, ROUNDS);
  $("#total").textContent = ROUNDS;
  $("#progressFill").style.width = `${(round / ROUNDS) * 100}%`;
}

async function vote(idx) {
  if (busy || !pair) return;
  busy = true;
  cards.forEach((c) => (c.disabled = true));
  const winnerCard = cards[idx], loserCard = cards[1 - idx];

  let r;
  try {
    r = await api("vote", { winner: pair[idx].id });
  } catch (e) {
    toast(e.message);
    busy = false;
    return loadPair();
  }

  // Show what the click did, in plain words.
  winnerCard.classList.add("won");
  loserCard.classList.add("lost");
  const wd = winnerCard.querySelector(".delta"), ld = loserCard.querySelector(".delta");
  wd.textContent = `+${r.delta}`; wd.className = "delta up show";
  ld.textContent = `−${r.delta}`; ld.className = "delta down show";
  $("#explain").innerHTML = "";
  $("#explain").append(
    el("b", { textContent: r.winner.name }), ` takes ${r.delta} points from `,
    el("b", { textContent: r.loser.name }), ". ",
    r.expected === 50
      ? `Their scores were even, so it's worth the standard ${r.delta}.`
      : r.expected < 50
        ? `That's an upset: ${r.winner.name} only had a ${r.expected}% chance, so it's worth more.`
        : `${r.winner.name} was expected to win (${r.expected}%), so it's worth less.`,
  );
  picks.push(r.winner);
  countVote();
  refreshBoard();

  round++;
  updateProgress();
  await sleep(1100);
  busy = false;
  if (round >= ROUNDS) showResults();
  else loadPair();
}

cards.forEach((c, i) => (c.onclick = () => vote(i)));
document.addEventListener("keydown", (e) => {
  if ($("#vote").classList.contains("hidden") || document.querySelector("dialog[open]")) return;
  if (e.key === "ArrowLeft") vote(0);
  if (e.key === "ArrowRight") vote(1);
});
$("#skip").onclick = () => { if (!busy) loadPair(); };

// ---------------- Player levels (your own voting progress, kept in this browser) ----------------
const LEVELS = [
  { at: 0,   name: "Newcomer",    icon: "🌱" },
  { at: 5,   name: "Scout",       icon: "🔎" },
  { at: 15,  name: "Spotter",     icon: "👀" },
  { at: 30,  name: "Judge",       icon: "⚖️" },
  { at: 50,  name: "Critic",      icon: "🎯" },
  { at: 80,  name: "Tastemaker",  icon: "✨" },
  { at: 120, name: "Expert",      icon: "🏅" },
  { at: 200, name: "Connoisseur", icon: "💎" },
  { at: 300, name: "Icon",        icon: "🌟" },
  { at: 500, name: "Legend",      icon: "👑" },
];
const PLAYER_KEY = "faceclash.votesCast";
let votesCast = Number(localStorage.getItem(PLAYER_KEY) || 0);
let levelAtStart = 0;

function levelFor(n) {
  let i = 0;
  while (i + 1 < LEVELS.length && n >= LEVELS[i + 1].at) i++;
  return i;
}
function renderPlayer(levelUp = false) {
  const i = levelFor(votesCast), L = LEVELS[i], next = LEVELS[i + 1];
  $("#playerIcon").textContent = L.icon;
  $("#playerLevel").textContent = i + 1;
  $("#playerName").textContent = L.name;
  $("#playerFill").style.width = next ? `${((votesCast - L.at) / (next.at - L.at)) * 100}%` : "100%";
  $("#playerNext").textContent = next ? `${next.at - votesCast} vote${next.at - votesCast === 1 ? "" : "s"} to ${next.name}` : `Max level · ${votesCast} votes`;
  if (levelUp) {
    $("#player").classList.remove("level-up"); void $("#player").offsetWidth; $("#player").classList.add("level-up");
    toast(`${L.icon} Level up! You're now a ${L.name}`);
  }
}
function countVote() {
  const before = levelFor(votesCast);
  votesCast++;
  localStorage.setItem(PLAYER_KEY, votesCast);
  renderPlayer(levelFor(votesCast) > before);
}

// ---------------- Game modes ----------------
const MODE_KEY = "faceclash.mode";
let mode = localStorage.getItem(MODE_KEY) || "classic";
let classicRounds = 10;
const roundsFor = (m) => (m === "quick" ? 5 : m === "marathon" ? 25 : classicRounds);
function renderModes() {
  document.querySelectorAll(".mode").forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", on);
  });
  $("#classicRounds").textContent = classicRounds;
}
document.querySelectorAll(".mode").forEach((b) => (b.onclick = () => {
  if (busy) return;
  mode = b.dataset.mode;
  localStorage.setItem(MODE_KEY, mode);
  ROUNDS = roundsFor(mode);
  renderModes();
  startGame();
}));

// ---------------- Results ----------------
async function showResults() {
  $("#vote").classList.add("hidden");
  $("#results").classList.remove("hidden");
  const { people } = await api("board");
  const medals = ["🥇", "🥈", "🥉"];
  $("#podium").replaceChildren(...people.slice(0, 3).map((p, i) =>
    el("li", { className: `p${i + 1}` },
      el("img", { src: p.img, alt: p.name, title: "See history", onclick: () => openPerson(p.id) }),
      el("div", { className: "medal", textContent: medals[i] }),
      el("div", { className: "n", textContent: p.name }),
      tierChip(p.tier),
      el("div", { className: "stats", textContent: `Score ${p.rating} · won ${p.wins} of ${p.votes}` }),
    )));
  const li = levelFor(votesCast), L = LEVELS[li];
  $("#levelSummary").textContent = li > levelAtStart
    ? `${L.icon} You levelled up to Level ${li + 1}: ${L.name}! You've cast ${votesCast} votes.`
    : `${L.icon} Level ${li + 1} · ${L.name} · ${votesCast} votes cast so far.`;
  $("#yourPicks").replaceChildren(
    "Your picks this game",
    el("div", { className: "thumbs" }, ...picks.map((p) => el("img", { src: p.img, alt: p.name, title: p.name }))),
  );
}

function startGame() {
  levelAtStart = levelFor(votesCast);
  round = 0;
  picks = [];
  updateProgress();
  $("#explain").textContent = "Pick one. Their score goes up, the other's goes down.";
  $("#results").classList.add("hidden");
  $("#vote").classList.remove("hidden");
  loadPair();
}
$("#again").onclick = startGame;

// ---------------- Live leaderboard ----------------
let lastRanks = new Map();
let lastBoardSig = "";
let lastVoteTotal = -1;
let boardTimer;

function ago(sec) {
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

async function refreshBoard() {
  let data;
  try { data = await api("board"); } catch { return; }
  const list = $("#board");

  // Nothing changed since last poll: keep the rows (and their photos) as they are.
  const sig = JSON.stringify([data.people, data.totalVotes]);
  if (sig === lastBoardSig && list.children.length) {
    renderRecent(data);
    return;
  }
  lastBoardSig = sig;

  // FLIP: remember old positions so rows slide to their new places.
  const before = new Map([...list.children].map((li) => [li.dataset.id, li.getBoundingClientRect().top]));

  const rows = data.people.map((p, i) => {
    const prev = lastRanks.get(p.id);
    const moved = prev === undefined || lastVoteTotal < 0 ? 0 : prev - i;
    const medal = ["🥇", "🥈", "🥉"][i];
    const li = el("li", { className: i < 3 && p.votes ? `top top-${i + 1}` : "", title: `${p.name}: won ${p.wins}, lost ${p.losses}` },
      el("span", { className: "rank", textContent: medal && p.votes ? medal : i + 1 }),
      el("span", { className: "who" },
        el("img", { src: p.img, alt: "", loading: "lazy" }),
        el("span", { className: "who-text" },
          el("span", { className: "who-name" },
            el("span", { className: "nm", textContent: p.name }),
            moved ? el("span", { className: `move ${moved > 0 ? "up" : "down"}`, textContent: moved > 0 ? `▲${moved}` : `▼${-moved}` }) : null,
          ),
          el("span", { className: "who-meta" },
            tierChip(p.tier, "small"),
            p.streak >= 2 ? el("span", { className: "streak", title: `${p.streak} wins in a row`, textContent: `🔥${p.streak}` }) : null,
          ),
        ),
      ),
      el("span", { className: "wins" },
        p.votes ? `${p.wins} of ${p.votes}` : "no votes",
        el("div", { className: "winbar" }, el("i", { style: `width:${p.winRate ?? 0}%` })),
      ),
      el("span", { className: "score", textContent: p.rating }),
    );
    li.dataset.id = p.id;
    li.onclick = () => openPerson(p.id);
    if (moved) li.classList.add("flash");
    return li;
  });
  list.replaceChildren(...rows);

  for (const li of list.children) {
    const old = before.get(li.dataset.id);
    if (old === undefined) continue;
    const dy = old - li.getBoundingClientRect().top;
    if (dy) li.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 450, easing: "ease-out" });
  }

  lastRanks = new Map(data.people.map((p, i) => [p.id, i]));
  $("#totalVotes").textContent = data.totalVotes.toLocaleString();

  renderRecent(data);
  lastVoteTotal = data.totalVotes;
}

function renderRecent(data) {
  const recent = $("#recent");
  const isNew = lastVoteTotal >= 0 && data.totalVotes > lastVoteTotal;
  recent.replaceChildren(...(data.recent.length
    ? data.recent.map((v, i) => el("li", { className: isNew && i === 0 ? "new" : "" },
        el("b", { textContent: v.winner }), " beat ", v.loser, ` (+${v.delta})`,
        el("span", { className: "t", textContent: ago(data.now - v.at) })))
    : [el("li", { textContent: "No votes yet. Be the first!" })]));
}

function startPolling() {
  clearInterval(boardTimer);
  boardTimer = setInterval(() => {
    if (document.hidden) return;
    refreshBoard();
    if (currentView === "stats") refreshStats();
  }, POLL_MS);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshBoard(); });

// ---------------- Tabs: Play / Stats ----------------
let currentView = "play";
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => showView(t.dataset.view)));
function showView(view) {
  currentView = view;
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.view === view;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on);
  });
  $("#playView").classList.toggle("hidden", view !== "play");
  $("#statsView").classList.toggle("hidden", view !== "stats");
  if (view === "stats") refreshStats();
}

// ---------------- Stats & charts ----------------
const SERIES_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];
let lastStatsKey = "";

function table(headers, rows) {
  const t = el("table");
  t.append(el("thead", {}, el("tr", {}, ...headers.map((x) => el("th", { textContent: x })))));
  t.append(el("tbody", {}, ...rows.map((r) => el("tr", {}, ...r.map((c) => el("td", { textContent: c }))))));
  return t;
}
const hourLabel = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

async function refreshStats() {
  let d;
  try { d = await api("stats"); } catch (e) { return toast(e.message); }
  const key = JSON.stringify([d.totalVotes, d.series.map((x) => x.id), d.hourly[d.hourly.length - 1].t]);
  $("#stTotal").textContent = d.totalVotes.toLocaleString();
  $("#stToday").textContent = d.votesToday.toLocaleString();
  $("#stFaces").textContent = d.faces;
  $("#stUpset").textContent = d.biggestUpset
    ? `${d.biggestUpset.winner} beat ${d.biggestUpset.loser} for +${d.biggestUpset.delta}`
    : "None yet";
  if (key === lastStatsKey) return; // nothing new: don't redraw
  lastStatsKey = key;

  // Color follows the face (by id order), not its rank, so a rank swap doesn't repaint lines.
  const byId = [...d.series].sort((a, b) => a.id - b.id);
  const color = new Map(byId.map((x, i) => [x.id, SERIES_COLORS[i]]));
  Charts.line($("#raceChart"), {
    series: d.series.map((x) => ({ name: x.name, color: color.get(x.id), points: x.points })),
    step: true,
    height: 300,
    xTitle: "vote #",
    xLabel: (x) => (x === 0 ? "Start" : `After vote #${x}`),
    ariaLabel: "Score of the top four faces after each vote",
    emptyText: "No votes yet. Play a round and the race will appear here.",
  });
  $("#raceTable").replaceChildren(table(
    ["Face", "Score now", "Matchups", "Highest", "Lowest"],
    d.series.map((x) => {
      const ys = x.points.map((p) => p[1]);
      return [x.name, ys[ys.length - 1], x.points.length - 1, Math.max(...ys), Math.min(...ys)];
    }),
  ));

  Charts.bars($("#hourChart"), {
    data: d.hourly.map((b) => ({ label: hourLabel(b.t), value: b.count, tip: `${hourLabel(b.t)} – ${hourLabel(b.t + 3600)}` })),
    every: 4,
    height: 220,
    ariaLabel: "Votes per hour over the last 24 hours",
  });
  $("#hourTable").replaceChildren(table(["Hour", "Votes"], d.hourly.map((b) => [hourLabel(b.t), b.count])));
}

// ---------------- One face's history ----------------
const personDlg = $("#personDlg");
let currentPersonId = null;
async function openPerson(id) {
  currentPersonId = id;
  let d;
  try { d = await api(`person&id=${encodeURIComponent(id)}`); } catch (e) { return toast(e.message); }
  const p = d.person;
  $("#pdImg").src = p.img;
  $("#pdName").textContent = p.name;
  $("#pdMeta").textContent = p.status === "pending" ? "Waiting for an admin to approve this photo"
    : p.status === "hidden" ? "Hidden by an admin (not in the game right now)"
    : p.votes ? `Won ${p.winRate}% of ${p.votes} matchups`
    : "No matchups yet";
  $("#pdScore").textContent = p.rating;
  $("#pdRank").textContent = p.status === "active" ? `#${p.rank}` : "–";
  $("#pdWins").textContent = p.wins;
  $("#pdLosses").textContent = p.losses;
  $("#pdPeak").textContent = p.peak;
  $("#pdStreak").textContent = p.streak;
  $("#pdBest").textContent = p.bestStreak;
  $("#pdTier").replaceWith(Object.assign(tierChip(p.tier, "big"), { id: "pdTier" }));
  $("#pdNext").textContent = p.tier.next == null ? "Top tier!" : `${Math.max(0, p.tier.next - p.rating)} pts to go`;
  $("#pdForm").replaceChildren(...(p.form.length
    ? p.form.map((r) => el("span", { className: `form-chip ${r === "W" ? "w" : "l"}`, textContent: r, title: r === "W" ? "Won" : "Lost" }))
    : [el("span", { className: "muted", textContent: "No matchups yet" })]));
  $("#pdRemoveMine").hidden = !myUploads()[p.id];
  $("#pdAdminDelete").hidden = !isAdmin;
  if (!personDlg.open) personDlg.showModal();
  Charts.line($("#personChart"), {
    series: [{ name: p.name, color: "var(--series-1)", points: d.history }],
    height: 200,
    xTitle: "matchup #",
    xLabel: (x) => (x === 0 ? "Start" : `Matchup #${x}`),
    tagLabel: (t) => (t === "W" ? "(won)" : "(lost)"),
    ariaLabel: `${p.name}'s score after each matchup`,
    emptyText: "No matchups yet. The chart fills in as people vote.",
  });
  $("#pdRivals").replaceChildren(...(d.rivals.length
    ? d.rivals.map((r) => el("li", {}, el("span", { textContent: r.name }), el("span", { className: "rec", textContent: `beat ${r.beat} · lost ${r.lostTo}` })))
    : [el("li", { textContent: "None yet" })]));
}

document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => b.closest("dialog").close()));

// ---------------- Add yourself (drag & drop) ----------------
const addDlg = $("#addDlg"), drop = $("#drop"), fileInput = $("#file");
let imageData = null;

function resetAddForm() {
  imageData = null;
  $("#addForm").reset();
  $("#preview").hidden = true;
  drop.classList.remove("has-img", "over");
  $("#dropText").innerHTML = "<b>Drop your photo here</b><br>or click to browse · paste works too";
  $("#addError").textContent = "";
  validate();
}
function validate() {
  $("#addSubmit").disabled = !(imageData && $("#name").value.trim() && $("#consent").checked);
}

// Crop to the card's 260×300 shape and compress to JPEG before uploading.
function toJpeg(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) return reject(new Error("Please choose an image file."));
    if (file.size > 20e6) return reject(new Error("That image is over 20 MB."));
    const img = new Image();
    img.onload = () => {
      const W = 520, H = 600, c = el("canvas", { width: W, height: H });
      const s = Math.max(W / img.width, H / img.height);
      c.getContext("2d").drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => reject(new Error("Couldn't read that image."));
    img.src = URL.createObjectURL(file);
  });
}

async function takeFile(file) {
  $("#addError").textContent = "";
  try {
    imageData = await toJpeg(file);
    $("#preview").src = imageData;
    $("#preview").hidden = false;
    drop.classList.add("has-img");
    $("#dropText").textContent = "Click or drop to change";
    if (!$("#name").value) $("#name").focus();
  } catch (e) {
    imageData = null;
    $("#addError").textContent = e.message;
  }
  validate();
}

$("#addBtn").onclick = () => { resetAddForm(); addDlg.showModal(); };
drop.addEventListener("click", (e) => { e.preventDefault(); fileInput.click(); });
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
fileInput.onchange = () => takeFile(fileInput.files[0]);
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => takeFile(e.dataTransfer.files[0]));
addDlg.addEventListener("paste", (e) => {
  const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
  if (item) takeFile(item.getAsFile());
});
// Stop a file dropped beside the box from opening in the tab.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
$("#name").oninput = validate;
$("#consent").onchange = validate;

$("#addForm").onsubmit = async (e) => {
  e.preventDefault();
  if ($("#addSubmit").disabled) return;
  $("#addSubmit").disabled = true;
  $("#addSubmit").textContent = "Adding…";
  try {
    const { person, deleteToken } = await api("add", { name: $("#name").value.trim(), consent: $("#consent").checked, image: imageData });
    saveMyUpload(person.id, deleteToken);
    addDlg.close();
    toast(person.status === "pending"
      ? "Thanks! Your photo will appear once an admin approves it."
      : `${person.name} is in! You can remove it any time from this page.`);
    refreshBoard();
    openPerson(person.id);
  } catch (err) {
    $("#addError").textContent = err.message;
  } finally {
    $("#addSubmit").textContent = "Add me";
    validate();
  }
};

// ---------------- Your uploads (private delete tokens) ----------------
const MY_KEY = "hotornot.myUploads";
function myUploads() {
  try { return JSON.parse(localStorage.getItem(MY_KEY)) || {}; } catch { return {}; }
}
function saveMyUpload(id, token) {
  const m = myUploads();
  m[id] = token;
  localStorage.setItem(MY_KEY, JSON.stringify(m));
}
function forgetUpload(id) {
  const m = myUploads();
  delete m[id];
  localStorage.setItem(MY_KEY, JSON.stringify(m));
}

// ---------------- Removal (yours or admin) ----------------
const removeDlg = $("#removeDlg");
let pendingRemove = null;
function askRemove(mode) {
  const name = $("#pdName").textContent;
  pendingRemove = { mode, id: currentPersonId };
  $("#removeTitle").textContent = mode === "mine" ? "Remove your photo?" : `Remove ${name}?`;
  $("#removeText").textContent = mode === "mine"
    ? "Your photo is deleted from the site straight away and won't be shown again. Past votes stay counted for the other faces."
    : `${name} is taken off the site for everyone. Past votes stay counted for the other faces. This can't be undone.`;
  removeDlg.showModal();
}
$("#pdRemoveMine").onclick = () => askRemove("mine");
$("#pdAdminDelete").onclick = () => askRemove("admin");
$("#removeConfirm").onclick = async () => {
  if (!pendingRemove) return;
  const { mode, id } = pendingRemove;
  $("#removeConfirm").disabled = true;
  try {
    if (mode === "mine") await api("remove", { id, token: myUploads()[id] });
    else await api("admin_delete", { id });
    forgetUpload(id);
    removeDlg.close();
    personDlg.close();
    toast(mode === "mine" ? "Your photo was removed" : "Face removed");
    lastStatsKey = "";
    refreshBoard();
    if (currentView === "stats") refreshStats();
    if (pair && pair.some((p) => p.id === id)) loadPair();
  } catch (e) {
    toast(e.message);
  } finally {
    $("#removeConfirm").disabled = false;
  }
};

// ---------------- Admin (full dashboard lives in admin.html) ----------------
let isAdmin = false;
async function refreshAdmin() {
  try { isAdmin = (await api("admin_status")).admin; } catch { isAdmin = false; }
  $("#adminBtn").textContent = isAdmin ? "Admin dashboard" : "Admin";
}

// ---------------- Site settings from the server ----------------
async function loadConfig() {
  try {
    const c = await api("config");
    classicRounds = c.roundsPerGame;
    ROUNDS = roundsFor(mode);
    renderModes();
    $("#addBtn").hidden = !c.uploadsOpen;
  } catch {}
}

// ---------------- Boot ----------------
renderPlayer();
renderModes();
refreshAdmin();
loadConfig().then(startGame);
refreshBoard();
startPolling();
