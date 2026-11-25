// Admin dashboard for FaceClash 2.0
const $ = (s) => document.querySelector(s);

async function api(action, body) {
  const res = await fetch(`api.php?action=${action}`, body === undefined
    ? { credentials: "same-origin" }
    : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: "Bad response from server" }));
  if (res.status === 403 && data.error === "Admin login required") showLogin();
  if (!res.ok) throw new Error(data.error || "Request failed");
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
function confirmBox(title, text, okLabel = "Confirm") {
  return new Promise((resolve) => {
    const d = $("#confirmDlg");
    $("#cTitle").textContent = title;
    $("#cText").textContent = text;
    $("#cOk").textContent = okLabel;
    const done = (v) => { d.close(); resolve(v); };
    $("#cOk").onclick = () => done(true);
    d.querySelector("[data-close]").onclick = () => done(false);
    d.oncancel = () => resolve(false);
    d.showModal();
  });
}
const when = (t) => new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const hourLabel = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// ---------------- Login ----------------
function showLogin() {
  $("#dash").hidden = true;
  $("#logout").hidden = true;
  $("#loginView").hidden = false;
  $("#loginPw").focus();
}
async function showDash() {
  $("#loginView").hidden = true;
  $("#dash").hidden = false;
  $("#logout").hidden = false;
  await loadOverview();
  showPane(location.hash.slice(1) || "overview");
}
$("#loginForm").onsubmit = async (e) => {
  e.preventDefault();
  $("#loginError").textContent = "";
  try {
    await api("admin_login", { password: $("#loginPw").value });
    $("#loginPw").value = "";
    showDash();
  } catch (err) {
    $("#loginError").textContent = err.message;
  }
};
$("#logout").onclick = async () => {
  try { await api("admin_logout", {}); } catch {}
  showLogin();
};

// ---------------- Navigation ----------------
const loaders = { overview: loadOverview, faces: loadFaces, approvals: loadFaces, votes: () => loadVotes(true), settings: loadSettings, account: () => {} };
function showPane(name) {
  if (!loaders[name]) name = "overview";
  document.querySelectorAll(".anav").forEach((b) => b.classList.toggle("active", b.dataset.pane === name));
  document.querySelectorAll(".pane").forEach((p) => (p.hidden = p.id !== `pane-${name}`));
  history.replaceState(null, "", `#${name}`);
  loaders[name]();
}
document.querySelectorAll(".anav").forEach((b) => (b.onclick = () => showPane(b.dataset.pane)));
window.addEventListener("hashchange", () => { if (!$("#dash").hidden) showPane(location.hash.slice(1)); });

// ---------------- Overview ----------------
async function loadOverview() {
  const o = await api("admin_overview");
  const set = (id, v) => ($(id).textContent = Number(v).toLocaleString());
  set("#ovTotal", o.totalVotes); set("#ovToday", o.votesToday); set("#ovHour", o.votesHour);
  set("#ovVoters", o.votersToday); set("#ovActive", o.activeFaces); set("#ovHidden", o.hiddenFaces);
  set("#ovPending", o.pending); set("#ovUploads", o.uploads);
  $("#pendingCount").textContent = o.pending;
  $("#pendingCount").hidden = !o.pending;
  if (!$("#pane-overview").hidden) {
    const st = await api("stats");
    Charts.bars($("#ovChart"), {
      data: st.hourly.map((b) => ({ label: hourLabel(b.t), value: b.count, tip: `${hourLabel(b.t)} – ${hourLabel(b.t + 3600)}` })),
      every: 4, height: 200, ariaLabel: "Votes per hour",
    });
  }
}

// ---------------- Faces & approvals ----------------
let faces = [];
const selected = new Set();
let visibleIds = [];   // ids on the current page
let matchingIds = [];  // ids matching search + filter, across all pages
let page = 1;
const PAGE_KEY = "hotornot.admin.pageSize";
let pageSize = localStorage.getItem(PAGE_KEY) || "all"; // "all" | "5" | "10" | "20" | "30"
const STATUS_LABEL = { active: "In the game", hidden: "Hidden", pending: "Awaiting approval" };

async function loadFaces() {
  faces = (await api("admin_faces")).faces;
  const present = new Set(faces.map((f) => f.id));
  [...selected].forEach((id) => { if (!present.has(id)) selected.delete(id); });
  renderFaces();
  renderApprovals();
  const pending = faces.filter((f) => f.status === "pending").length;
  $("#pendingCount").textContent = pending;
  $("#pendingCount").hidden = !pending;
}

async function updateFace(id, change, msg) {
  try {
    await api("admin_update_face", { id, ...change });
    toast(msg);
    await loadFaces();
  } catch (e) { toast(e.message); }
}
async function removeFace(f) {
  const ok = await confirmBox(`Remove ${f.name}?`,
    f.uploaded ? "Their photo is deleted from the server. Past votes stay counted for other faces. This can't be undone."
               : "This built-in face is taken off the site for good. Past votes stay counted for other faces.", "Remove");
  if (!ok) return;
  try { await api("admin_delete", { id: f.id }); toast(`${f.name} removed`); await loadFaces(); } catch (e) { toast(e.message); }
}

function renderFaces() {
  const q = $("#faceSearch").value.trim().toLowerCase();
  const filter = $("#faceFilter").value;
  const list = faces.filter((f) =>
    (!q || f.name.toLowerCase().includes(q)) &&
    (filter === "all" || f.status === filter || f.source === filter));
  matchingIds = list.map((f) => f.id);

  // Pagination
  const per = pageSize === "all" ? Math.max(1, list.length) : Number(pageSize);
  const pages = Math.max(1, Math.ceil(list.length / per));
  page = Math.min(Math.max(1, page), pages);
  const start = (page - 1) * per;
  const rows = list.slice(start, start + per);
  visibleIds = rows.map((f) => f.id);
  renderPager(list.length, start, rows.length, pages);

  $("#faceRows").replaceChildren(...(rows.length ? rows.map((f) => {
    const name = el("button", { className: "name-edit", textContent: f.name, title: "Click to rename" });
    name.onclick = () => {
      const input = el("input", { value: f.name, maxLength: 24, className: "rename" });
      const save = () => {
        const v = input.value.trim();
        if (v && v !== f.name) updateFace(f.id, { name: v }, `Renamed to ${v}`); else renderFaces();
      };
      input.onkeydown = (e) => { if (e.key === "Enter") save(); if (e.key === "Escape") renderFaces(); };
      input.onblur = save;
      name.replaceWith(input);
      input.focus(); input.select();
    };
    const actions = el("td", { className: "row-actions" });
    if (f.status === "pending") {
      actions.append(el("button", { className: "chip ok", textContent: "Approve", onclick: () => updateFace(f.id, { status: "active" }, `${f.name} approved`) }));
    } else {
      actions.append(el("button", {
        className: "chip", textContent: f.status === "hidden" ? "Show" : "Hide",
        onclick: () => updateFace(f.id, { status: f.status === "hidden" ? "active" : "hidden" }, f.status === "hidden" ? `${f.name} is back in the game` : `${f.name} hidden`),
      }));
      actions.append(el("button", {
        className: "chip", textContent: "Reset", disabled: !f.votes,
        onclick: async () => {
          if (!(await confirmBox(`Reset ${f.name}?`, `Score, wins and losses go back to 0. Other faces are not affected.`, "Reset"))) return;
          try { await api("admin_reset_face", { id: f.id }); toast(`${f.name} reset to 0`); loadFaces(); } catch (e) { toast(e.message); }
        },
      }));
    }
    actions.append(el("button", { className: "chip danger", textContent: "Remove", onclick: () => removeFace(f) }));

    const box = el("input", { type: "checkbox", checked: selected.has(f.id), ariaLabel: `Select ${f.name}` });
    box.onchange = () => { box.checked ? selected.add(f.id) : selected.delete(f.id); updateBulkBar(); };
    return el("tr", { className: `st-${f.status}${selected.has(f.id) ? " selected" : ""}` },
      el("td", { className: "check-col" }, box),
      el("td", {}, el("img", { src: f.img, alt: "", className: "thumb", loading: "lazy" })),
      el("td", {}, name, f.source === "visitor" ? el("span", { className: "tag", textContent: "visitor upload" })
        : f.source === "admin" ? el("span", { className: "tag admin", textContent: "added by admin" }) : null),
      el("td", {}, el("span", { className: `status ${f.status}`, textContent: STATUS_LABEL[f.status] || f.status })),
      el("td", { className: "num strong" }, el("span", { className: `tier-chip t-${f.tier.key}`, textContent: f.tier.icon, title: f.tier.label }), " ", String(f.rating)),
      el("td", { className: "num", textContent: f.wins }),
      el("td", { className: "num", textContent: f.losses }),
      el("td", { className: "num", textContent: f.winRate == null ? "–" : `${f.winRate}%` }),
      actions,
    );
  }) : [el("tr", {}, el("td", { colSpan: 9, className: "empty-row", textContent: "No faces match." }))]));
  updateBulkBar();
}

// ---------------- Bulk actions ----------------
function updateBulkBar() {
  const n = selected.size;
  $("#bulkBar").hidden = n === 0;
  $("#bulkCount").textContent = n;
  const chosen = faces.filter((f) => selected.has(f.id));
  $("#bulkApprove").hidden = !chosen.some((f) => f.status === "pending");
  document.querySelectorAll("#faceRows tr").forEach((tr) => {
    const cb = tr.querySelector(".check-col input");
    if (cb) tr.classList.toggle("selected", cb.checked);
  });
  const shownSelected = visibleIds.filter((id) => selected.has(id)).length;
  const allMatching = matchingIds.length > 0 && matchingIds.every((id) => selected.has(id));
  const offer = $("#selectMatching");
  offer.hidden = !(shownSelected === visibleIds.length && visibleIds.length > 0 && matchingIds.length > visibleIds.length && !allMatching);
  offer.textContent = `Select all ${matchingIds.length} matching`;
  const all = $("#selectAll");
  all.checked = visibleIds.length > 0 && shownSelected === visibleIds.length;
  all.indeterminate = shownSelected > 0 && shownSelected < visibleIds.length;
}
$("#selectAll").onchange = (e) => {
  visibleIds.forEach((id) => (e.target.checked ? selected.add(id) : selected.delete(id)));
  renderFaces();
};
$("#selectMatching").onclick = () => { matchingIds.forEach((id) => selected.add(id)); renderFaces(); };
$("#bulkClear").onclick = () => { selected.clear(); renderFaces(); };

const BULK = {
  approve: { verb: "approved" },
  show:    { verb: "back in the game" },
  hide:    { verb: "hidden" },
  reset:   { verb: "reset to 0", confirm: (n) => [`Reset ${n} face${n > 1 ? "s" : ""}?`, "Score, wins and losses go back to 0 for the selected faces. Other faces are not affected.", "Reset"] },
  remove:  { verb: "deleted", confirm: (n, up) => [`Delete ${n} face${n > 1 ? "s" : ""}?`,
    `They are taken off the site for good${up ? `, and ${up} uploaded photo${up > 1 ? "s are" : " is"} deleted from the server` : ""}. Past votes stay counted for other faces. This can't be undone.`, `Delete ${n}`] },
};
document.querySelectorAll("[data-bulk]").forEach((btn) => (btn.onclick = async () => {
  const op = btn.dataset.bulk, ids = [...selected], cfg = BULK[op];
  if (!ids.length) return;
  if (cfg.confirm) {
    const uploads = faces.filter((f) => selected.has(f.id) && f.uploaded).length;
    const [title, text, ok] = cfg.confirm(ids.length, uploads);
    if (!(await confirmBox(title, text, ok))) return;
  }
  document.querySelectorAll("[data-bulk]").forEach((b) => (b.disabled = true));
  try {
    const r = await api("admin_bulk", { op, ids });
    toast(`${r.changed} face${r.changed === 1 ? "" : "s"} ${cfg.verb}`);
    if (op === "remove") selected.clear();
    await loadFaces();
    loadOverview();
  } catch (e) {
    toast(e.message);
  } finally {
    document.querySelectorAll("[data-bulk]").forEach((b) => (b.disabled = false));
  }
}));
$("#faceSearch").oninput = () => { page = 1; renderFaces(); };
$("#faceFilter").onchange = () => { page = 1; renderFaces(); };

// ---------------- Pagination ----------------
$("#pageSize").value = pageSize;
$("#pageSize").onchange = (e) => {
  pageSize = e.target.value;
  localStorage.setItem(PAGE_KEY, pageSize);
  page = 1;
  renderFaces();
};
function pageButton(label, target, { current = false, disabled = false, aria } = {}) {
  const b = el("button", { className: `page-btn${current ? " current" : ""}`, textContent: label, disabled });
  if (aria) b.setAttribute("aria-label", aria);
  if (current) b.setAttribute("aria-current", "page");
  b.onclick = () => { page = target; renderFaces(); $("#pane-faces").scrollIntoView({ block: "start", behavior: "smooth" }); };
  return b;
}
function renderPager(total, start, count, pages) {
  $("#pageInfo").textContent = total
    ? `Showing ${start + 1}–${start + count} of ${total}`
    : "No faces";
  const nums = $("#pageNums");
  nums.replaceChildren();
  $("#pager").hidden = pages <= 1;
  if (pages <= 1) return;
  nums.append(pageButton("‹", page - 1, { disabled: page === 1, aria: "Previous page" }));
  // 1 … 4 5 6 … 12
  const want = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  let last = 0;
  [...want].sort((a, b) => a - b).forEach((n) => {
    if (n - last > 1) nums.append(el("span", { className: "page-gap", textContent: "…" }));
    nums.append(pageButton(String(n), n, { current: n === page, aria: `Page ${n}` }));
    last = n;
  });
  nums.append(pageButton("›", page + 1, { disabled: page === pages, aria: "Next page" }));
}

async function renderApprovals() {
  const pending = faces.filter((f) => f.status === "pending");
  const cfg = await api("config");
  $("#approvalHint").textContent = cfg.requireApproval
    ? "New uploads wait here until you approve them."
    : "Approval is off, so uploads go live straight away. Turn it on in Settings.";
  $("#approvalGrid").replaceChildren(...(pending.length ? pending.map((f) =>
    el("div", { className: "approval-card" },
      el("img", { src: f.img, alt: f.name }),
      el("div", { className: "ap-name", textContent: f.name }),
      el("div", { className: "ap-meta", textContent: `Uploaded ${when(f.createdAt)}` }),
      el("div", { className: "ap-actions" },
        el("button", { className: "primary", textContent: "Approve", onclick: () => updateFace(f.id, { status: "active" }, `${f.name} approved`) }),
        el("button", { className: "link danger", textContent: "Reject", onclick: () => removeFace(f) }),
      ),
    )) : [el("p", { className: "empty-row", textContent: "Nothing waiting for approval." })]));
}

// ---------------- Admin: add faces (many at once) ----------------
const addDlg = $("#addFacesDlg"), aDrop = $("#aDrop"), aFiles = $("#aFiles");
const MAX_BATCH = 50;
let addItems = []; // { id, name, data, state: "ready"|"uploading"|"done"|"error", error }

function nameFromFile(fn) {
  const base = fn.replace(/\.[^.]+$/, "").replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
  const words = base.split(" ").filter((w) => !/^(img|dsc|dscn|photo|image|pxl|screenshot)?\d*$/i.test(w)); // drop camera junk like IMG, DSC0042, 20261125
  const nice = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  return (nice || "Face").slice(0, 24);
}
function toJpeg(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) return reject(new Error("Not an image"));
    if (file.size > 20e6) return reject(new Error("Over 20 MB"));
    const img = new Image();
    img.onload = () => {
      const W = 520, H = 600, c = el("canvas", { width: W, height: H });
      const sc = Math.max(W / img.width, H / img.height);
      c.getContext("2d").drawImage(img, (W - img.width * sc) / 2, (H - img.height * sc) / 2, img.width * sc, img.height * sc);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => reject(new Error("Couldn't read image"));
    img.src = URL.createObjectURL(file);
  });
}
async function takeFiles(list) {
  $("#aError").textContent = "";
  const files = [...list].filter((f) => f.type.startsWith("image/"));
  const room = MAX_BATCH - addItems.filter((i) => i.state !== "done").length;
  if (files.length > room) $("#aError").textContent = `Only ${MAX_BATCH} photos per batch. Extra files were skipped.`;
  for (const f of files.slice(0, Math.max(0, room))) {
    try {
      addItems.push({ id: crypto.randomUUID(), name: nameFromFile(f.name), data: await toJpeg(f), state: "ready" });
    } catch (e) {
      $("#aError").textContent = `${f.name}: ${e.message}`;
    }
    renderAddItems();
  }
}
function renderAddItems() {
  $("#aItems").replaceChildren(...addItems.map((it) => {
    const input = el("input", { value: it.name, maxLength: 24, disabled: it.state === "uploading" || it.state === "done", ariaLabel: "Name" });
    input.oninput = () => { it.name = input.value; validateAdd(); };
    const rm = el("button", { type: "button", className: "item-x", textContent: "✕", ariaLabel: "Remove from batch", hidden: it.state === "uploading" || it.state === "done" });
    rm.onclick = () => { addItems = addItems.filter((x) => x !== it); renderAddItems(); };
    const badge = it.state === "done" ? el("span", { className: "item-state ok", textContent: "Added" })
      : it.state === "uploading" ? el("span", { className: "item-state", textContent: "Uploading…" })
      : it.state === "error" ? el("span", { className: "item-state err", textContent: it.error, title: it.error }) : null;
    return el("div", { className: `add-item ${it.state}` }, el("img", { src: it.data, alt: "" }), rm, badge, input);
  }));
  validateAdd();
}
function validateAdd() {
  const todo = addItems.filter((i) => i.state === "ready" || i.state === "error");
  const namesOk = todo.every((i) => i.name.trim().length > 0);
  $("#aSubmit").disabled = !todo.length || !namesOk || !$("#aRights").checked;
  $("#aSubmit").textContent = todo.length ? `Add ${todo.length} face${todo.length > 1 ? "s" : ""}` : "Add faces";
  aDrop.classList.toggle("compact", addItems.length > 0);
}
$("#addFacesBtn").onclick = () => {
  addItems = [];
  $("#addFacesForm").reset();
  $("#aError").textContent = "";
  renderAddItems();
  addDlg.showModal();
};
aDrop.addEventListener("click", (e) => { e.preventDefault(); aFiles.click(); });
aDrop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); aFiles.click(); } });
aFiles.onchange = () => { takeFiles(aFiles.files); aFiles.value = ""; };
["dragenter", "dragover"].forEach((t) => aDrop.addEventListener(t, (e) => { e.preventDefault(); aDrop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => aDrop.addEventListener(t, (e) => { e.preventDefault(); aDrop.classList.remove("over"); }));
aDrop.addEventListener("drop", (e) => takeFiles(e.dataTransfer.files));
addDlg.addEventListener("paste", (e) => takeFiles([...e.clipboardData.items].filter((i) => i.type.startsWith("image/")).map((i) => i.getAsFile())));
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
$("#aRights").onchange = validateAdd;
addDlg.querySelector("[data-close]").onclick = () => addDlg.close();

$("#addFacesForm").onsubmit = async (e) => {
  e.preventDefault();
  if ($("#aSubmit").disabled) return;
  $("#aSubmit").disabled = true;
  $("#aError").textContent = "";
  let ok = 0, failed = 0;
  for (const it of addItems.filter((i) => i.state === "ready" || i.state === "error")) {
    it.state = "uploading"; renderAddItems(); $("#aSubmit").disabled = true;
    try {
      await api("admin_add", { name: it.name.trim(), image: it.data, rights: true });
      it.state = "done"; ok++;
    } catch (err) {
      it.state = "error"; it.error = err.message; failed++;
    }
    renderAddItems(); $("#aSubmit").disabled = true;
  }
  await loadFaces();
  loadOverview();
  if (!failed) {
    addDlg.close();
    toast(`${ok} face${ok === 1 ? "" : "s"} added`);
  } else {
    $("#aError").textContent = `${ok} added, ${failed} failed. Fix and try again, or remove them.`;
    validateAdd();
  }
};

// ---------------- Votes ----------------
let oldestVote = null;
async function loadVotes(fresh) {
  if (fresh) { oldestVote = null; $("#voteRows").replaceChildren(); }
  const d = await api(`admin_votes${oldestVote ? `&before=${oldestVote}` : ""}`);
  if (fresh && !d.votes.length) {
    $("#voteRows").append(el("tr", {}, el("td", { colSpan: 6, className: "empty-row", textContent: "No votes yet." })));
  }
  d.votes.forEach((v) => $("#voteRows").append(el("tr", {},
    el("td", { className: "muted", textContent: v.id }),
    el("td", { textContent: when(v.at) }),
    el("td", {}, el("b", { textContent: v.winner }), v.winnerAfter != null ? el("span", { className: "muted", textContent: ` → ${v.winnerAfter}` }) : null),
    el("td", {}, v.loser, v.loserAfter != null ? el("span", { className: "muted", textContent: ` → ${v.loserAfter}` }) : null),
    el("td", { className: "num", textContent: `±${v.delta}` }),
    el("td", {}, el("code", { textContent: v.voter })),
  )));
  if (d.votes.length) oldestVote = d.votes[d.votes.length - 1].id;
  $("#moreVotes").hidden = !d.more;
}
$("#moreVotes").onclick = () => loadVotes(false);

// ---------------- Settings ----------------
async function loadSettings() {
  const { settings: s } = await api("admin_overview");
  $("#setRounds").value = s.roundsPerGame;
  $("#setUploads").checked = s.uploadsOpen;
  $("#setApproval").checked = s.requireApproval;
}
$("#settingsForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const { settings: s } = await api("admin_settings", {
      roundsPerGame: Number($("#setRounds").value),
      uploadsOpen: $("#setUploads").checked,
      requireApproval: $("#setApproval").checked,
    });
    $("#setRounds").value = s.roundsPerGame;
    toast("Settings saved");
  } catch (err) { toast(err.message); }
};
$("#resetAll").onclick = async () => {
  if (!(await confirmBox("Reset all scores?", "Every face goes back to 0 and all vote history and charts are deleted, for everyone. Photos are kept. This can't be undone.", "Reset everything"))) return;
  try { await api("reset", {}); toast("All scores reset to 0"); loadOverview(); } catch (err) { toast(err.message); }
};

// ---------------- Account ----------------
$("#pwForm").onsubmit = async (e) => {
  e.preventDefault();
  $("#pwError").textContent = "";
  if ($("#pwNew").value !== $("#pwNew2").value) { $("#pwError").textContent = "New passwords don't match."; return; }
  try {
    await api("admin_password", { current: $("#pwCurrent").value, new: $("#pwNew").value });
    e.target.reset();
    toast("Password changed");
  } catch (err) { $("#pwError").textContent = err.message; }
};

// ---------------- Boot ----------------
(async () => {
  try {
    const s = await api("admin_status");
    if (s.admin) showDash(); else showLogin();
  } catch { showLogin(); }
  setInterval(() => { if (!document.hidden && !$("#dash").hidden && !$("#pane-overview").hidden) loadOverview(); }, 5000);
})();
