"use strict";

const ORG = {
  usfs: "USFS",
  tnc: "TNC",
};

const state = {
  ready: false,
  people: [],
  links: [],
  query: "",
  selectedId: null,
};

const positions = new Map();
let edges = [];
let energy = 0;
let raf = 0;
let poll = 0;
let userMoved = false;
let toastTimer = 0;
const cam = { x: 0, y: 0, k: 1 };
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const boot = document.querySelector("#boot");
const appView = document.querySelector("#app-view");
const canvas = document.querySelector("#grove");
const ctx = canvas.getContext("2d");
const tip = document.querySelector("#tip");

function api(path, options = {}) {
  const opts = {
    method: options.method || "GET",
    headers: { "X-Canopy": "1" },
    credentials: "same-origin",
  };
  if (options.body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(options.body);
  }
  return fetch(path, opts).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || "Something went wrong.");
      error.status = res.status;
      throw error;
    }
    return data;
  });
}

function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2400);
}

function showError(id, message) {
  const el = document.querySelector(id);
  el.textContent = message || "";
  el.hidden = !message;
}

function pairPeople(link) {
  return {
    tnc: personById(link.tnc_id),
    usfs: personById(link.usfs_id),
  };
}

function personById(id) {
  return state.people.find((person) => person.id === id) || null;
}

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function shortName(name) {
  if (name.length <= 22) return name;
  return `${name.slice(0, 21)}…`;
}

function signature(data) {
  const people = data.people.map((person) => `${person.id}:${person.name}:${person.office}:${person.org}`).join("|");
  const links = data.links.map((link) => `${link.id}:${link.tnc_id}:${link.usfs_id}:${link.place}:${link.purpose}`).join("|");
  return `${people}#${links}`;
}

let lastSignature = "";
let pendingFit = false;

function applyNetwork(data, { refit = false } = {}) {
  const next = signature(data);
  const changed = next !== lastSignature;
  lastSignature = next;
  state.ready = true;
  state.people = data.people;
  state.links = data.links;
  if (state.selectedId && !personById(state.selectedId)) state.selectedId = null;
  syncGraph();
  renderChrome();
  renderMine();
  renderCloud();
  renderDetail();
  if (changed) energy = Math.max(energy, 0.85);
  if (refit) {
    userMoved = false;
    pendingFit = true;
  }
  wake();
}

function myLinks() {
  return state.links.slice().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

function groupedNeighbors(personId) {
  const groups = new Map();
  state.links.forEach((link) => {
    let other = null;
    if (link.tnc_id === personId) other = link.usfs_id;
    else if (link.usfs_id === personId) other = link.tnc_id;
    if (!other) return;
    if (!groups.has(other)) groups.set(other, []);
    groups.get(other).push(link);
  });
  return [...groups.entries()]
    .map(([id, reports]) => ({ person: personById(id), reports }))
    .filter((group) => group.person)
    .sort((a, b) => a.person.name.localeCompare(b.person.name));
}

function renderChrome() {
  const ties = state.links.length;
  const noun = state.people.length === 1 ? "person" : "people";
  const tieNoun = ties === 1 ? "tie" : "ties";
  document.querySelector("#stats").textContent = `${state.people.length} ${noun} · ${ties} ${tieNoun}`;
}

function renderMine() {
  const host = document.querySelector("#mine");
  host.replaceChildren();
  const links = myLinks();
  if (!links.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No partnerships yet.";
    host.append(empty);
    return;
  }
  links.forEach((link) => {
    const pair = pairPeople(link);
    if (!pair.tnc || !pair.usfs) return;
    const row = document.createElement("div");
    row.className = "tie";
    if (pair.tnc.id === state.selectedId || pair.usfs.id === state.selectedId) row.classList.add("is-selected");
    const who = document.createElement("button");
    who.type = "button";
    who.className = "who";
    who.dataset.action = "focus";
    who.dataset.id = String(pair.usfs.id);
    const strong = document.createElement("strong");
    strong.textContent = `${pair.tnc.name} & ${pair.usfs.name}`;
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = `${link.place} — ${link.purpose}`;
    who.append(strong, sub);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.dataset.action = "remove";
    remove.dataset.id = String(link.id);
    remove.dataset.name = `${pair.tnc.name} and ${pair.usfs.name}`;
    remove.setAttribute("aria-label", `Remove ${pair.tnc.name} and ${pair.usfs.name}`);
    remove.textContent = "Remove";
    row.append(who, remove);
    host.append(row);
  });
}

const STOP_WORDS = new Set("a an the and or of to for with on in at by from their they them our we is are be this that as into over about across through per its it".split(" "));

function renderCloud() {
  const host = document.querySelector("#cloud");
  const counts = new Map();
  state.links.forEach((link) => {
    String(link.purpose || "").toLowerCase().split(/[^a-z0-9]+/).forEach((word) => {
      if (word.length < 3 || STOP_WORDS.has(word)) return;
      counts.set(word, (counts.get(word) || 0) + 1);
    });
  });
  const words = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40);
  host.replaceChildren();
  if (!words.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Purpose words will gather here.";
    host.append(empty);
    return;
  }
  const max = words[0][1];
  words.forEach(([word, count]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cloud-word";
    button.textContent = word;
    button.style.fontSize = `${(0.85 + (count / max) * 1.35).toFixed(2)}rem`;
    button.dataset.action = "word";
    button.dataset.word = word;
    button.title = count === 1 ? "1 partnership" : `${count} partnerships`;
    host.append(button);
  });
}

function renderDetail() {
  const panel = document.querySelector("#detail");
  const person = personById(state.selectedId);
  if (!person) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }
  panel.hidden = false;
  panel.replaceChildren();

  const head = document.createElement("div");
  head.className = "detail-head";
  const titleWrap = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = person.name;
  const meta = document.createElement("p");
  meta.className = "meta";
  const bits = [];
  if (ORG[person.org]) bits.push(ORG[person.org]);
  if (person.office) bits.push(person.office);
  meta.textContent = bits.join(" · ") || "On the map";
  titleWrap.append(title, meta);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "close";
  close.dataset.action = "clear";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  head.append(titleWrap, close);
  panel.append(head);

  const neighbors = groupedNeighbors(person.id);
  if (!neighbors.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No partnerships yet.";
    panel.append(empty);
  } else {
    neighbors.forEach((group) => {
      const block = document.createElement("div");
      block.className = "link-block neighbor";
      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "who person-line";
      jump.dataset.action = "focus";
      jump.dataset.id = String(group.person.id);
      const strong = document.createElement("strong");
      strong.textContent = group.person.name;
      jump.append(strong);
      group.reports.forEach((report) => {
        const line = document.createElement("span");
        line.className = "sub";
        line.textContent = `${report.place} — ${report.purpose}`;
        jump.append(line);
      });
      block.append(jump);
      group.reports.forEach((report) => {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "remove";
        remove.dataset.action = "remove";
        remove.dataset.id = String(report.id);
        remove.dataset.name = group.person.name;
        remove.textContent = "Remove";
        block.append(remove);
      });
      panel.append(block);
    });
  }
}

function showApp(data) {
  boot.hidden = true;
  appView.hidden = false;
  applyNetwork(data, { refit: true });
  resize();
  requestAnimationFrame(resize);
  clearInterval(poll);
  poll = setInterval(() => {
    if (!document.hidden) refresh().catch((error) => toast(error.message));
  }, 12000);
  document.querySelector("#tnc-name").focus();
}

function refresh() {
  return api("/api/network").then((data) => {
    const keep = userMoved;
    applyNetwork(data, { refit: false });
    userMoved = keep;
    return data;
  });
}

function syncGraph() {
  const degree = new Map();
  const grouped = new Map();
  state.links.forEach((link) => {
    const a = Math.min(link.tnc_id, link.usfs_id);
    const b = Math.max(link.tnc_id, link.usfs_id);
    const key = `${a}:${b}`;
    if (!grouped.has(key)) grouped.set(key, { from: a, to: b, reports: [] });
    grouped.get(key).reports.push(link);
  });
  edges = [...grouped.values()];
  edges.forEach((edge) => {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  });

  const live = new Set(state.people.map((person) => person.id));
  state.people.forEach((person, index) => {
    const existing = positions.get(person.id);
    const radius = Math.min(30, 16 + (degree.get(person.id) || 0) * 1.7);
    if (existing) {
      existing.r = radius;
      existing.person = person;
      return;
    }
    const angle = (index / Math.max(state.people.length, 1)) * Math.PI * 2;
    const ring = 70 + state.people.length * 6;
    positions.set(person.id, {
      x: Math.cos(angle) * ring,
      y: Math.sin(angle) * ring,
      vx: 0,
      vy: 0,
      r: radius,
      person,
      pin: false,
    });
  });
  [...positions.keys()].forEach((id) => {
    if (!live.has(id)) positions.delete(id);
  });
}

function matches(person) {
  const query = state.query || "";
  if (!query) return true;
  const hay = `${person.name} ${person.office || ""} ${ORG[person.org] || ""}`.toLowerCase();
  if (hay.includes(query)) return true;
  return state.links.some((link) => (
    (link.tnc_id === person.id || link.usfs_id === person.id)
    && `${link.place} ${link.purpose}`.toLowerCase().includes(query)
  ));
}

function neighborIds(id) {
  const ids = new Set([id]);
  edges.forEach((edge) => {
    if (edge.from === id) ids.add(edge.to);
    if (edge.to === id) ids.add(edge.from);
  });
  return ids;
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  draw();
}

function fit(markMoved = true) {
  const list = [...positions.values()];
  if (!list.length) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  list.forEach((node) => {
    minX = Math.min(minX, node.x - node.r);
    minY = Math.min(minY, node.y - node.r);
    maxX = Math.max(maxX, node.x + node.r);
    maxY = Math.max(maxY, node.y + node.r + 22);
  });
  const width = canvas.clientWidth || 800;
  const height = canvas.clientHeight || 600;
  const k = Math.min(width / (maxX - minX + 140), height / (maxY - minY + 140), 1.7);
  cam.k = Math.max(0.45, k);
  cam.x = -((minX + maxX) / 2);
  cam.y = -((minY + maxY) / 2);
  if (markMoved) userMoved = true;
  draw();
}

function toWorld(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left - rect.width / 2;
  const y = clientY - rect.top - rect.height / 2;
  return { x: x / cam.k - cam.x, y: y / cam.k - cam.y };
}

function nodeAt(point) {
  const nodes = [...positions.entries()].reverse();
  for (const [id, node] of nodes) {
    if (Math.hypot(node.x - point.x, node.y - point.y) <= node.r + 8 / cam.k) return id;
  }
  return null;
}

function edgeAt(point) {
  let best = null;
  let bestDist = 10;
  edges.forEach((edge) => {
    const a = positions.get(edge.from);
    const b = positions.get(edge.to);
    if (!a || !b) return;
    const dist = pointSegmentDistance(point, a, b) * cam.k;
    if (dist < bestDist) {
      bestDist = dist;
      best = edge;
    }
  });
  return best;
}

function pointSegmentDistance(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy || 1;
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / len;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + t * dx;
  const y = a.y + t * dy;
  return Math.hypot(point.x - x, point.y - y);
}

function step() {
  const ids = [...positions.keys()];
  const scale = Math.min(1, energy);
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = positions.get(ids[i]);
      const b = positions.get(ids[j]);
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let dist = Math.hypot(dx, dy) || 0.1;
      const min = a.r + b.r + 48;
      let force = (640 / dist) * scale;
      if (dist < min) force += (min - dist) * 0.18;
      const ux = dx / dist;
      const uy = dy / dist;
      if (!a.pin) { a.vx += ux * force; a.vy += uy * force; }
      if (!b.pin) { b.vx -= ux * force; b.vy -= uy * force; }
    }
  }
  edges.forEach((edge) => {
    const a = positions.get(edge.from);
    const b = positions.get(edge.to);
    if (!a || !b) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 0.1;
    const force = (dist - 168) * 0.02 * scale;
    const ux = dx / dist;
    const uy = dy / dist;
    if (!a.pin) { a.vx += ux * force; a.vy += uy * force; }
    if (!b.pin) { b.vx -= ux * force; b.vy -= uy * force; }
  });
  positions.forEach((node) => {
    if (node.pin) {
      node.vx = 0;
      node.vy = 0;
      return;
    }
    node.vx += -node.x * 0.01 * scale;
    node.vy += -node.y * 0.01 * scale;
    node.vx *= 0.72;
    node.vy *= 0.72;
    const speed = Math.hypot(node.vx, node.vy);
    if (speed > 16) {
      node.vx = (node.vx / speed) * 16;
      node.vy = (node.vy / speed) * 16;
    }
    node.x += node.vx;
    node.y += node.vy;
  });
  energy *= 0.985;
  if (pendingFit && energy < 0.2 && !userMoved) {
    pendingFit = false;
    fit(false);
  }
}

function draw() {
  if (!state.ready) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (!width || !height) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.translate(width / 2, height / 2);
  ctx.scale(cam.k, cam.k);
  ctx.translate(cam.x, cam.y);

  const selected = state.selectedId;
  const focus = selected ? neighborIds(selected) : null;
  const querying = Boolean(state.query);

  edges.forEach((edge) => {
    const a = positions.get(edge.from);
    const b = positions.get(edge.to);
    if (!a || !b) return;
    let alpha = 0.55;
    if (querying) {
      alpha = matches(a.person) && matches(b.person) ? 0.8 : 0.08;
    } else if (focus) {
      alpha = focus.has(edge.from) && focus.has(edge.to) ? 0.9 : 0.08;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo((a.x + b.x) / 2 - dy * 0.08, (a.y + b.y) / 2 + dx * 0.08, b.x, b.y);
    ctx.strokeStyle = "#e4c56a";
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.4 + Math.min(edge.reports.length, 4) * 1.3;
    ctx.stroke();
    ctx.globalAlpha = 1;
  });

  positions.forEach((node) => {
    const person = node.person;
    let alpha = 1;
    if (querying) alpha = matches(person) ? 1 : 0.12;
    else if (focus) alpha = focus.has(person.id) ? 1 : 0.16;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.ellipse(node.x, node.y + node.r * 0.2, node.r * 0.82, node.r * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();

    const paint = ctx.createRadialGradient(node.x - node.r * 0.35, node.y - node.r * 0.4, node.r * 0.1, node.x, node.y, node.r);
    if (person.org === "tnc") {
      paint.addColorStop(0, "#d7eef8");
      paint.addColorStop(1, "#1f6f9a");
    } else if (person.org === "usfs") {
      paint.addColorStop(0, "#dff3d4");
      paint.addColorStop(1, "#1f7a45");
    } else {
      paint.addColorStop(0, "#f4efe2");
      paint.addColorStop(1, "#c9bea4");
    }
    ctx.beginPath();
    ctx.fillStyle = paint;
    ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
    ctx.fill();
    if (person.id === selected) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(244,241,231,0.9)";
      ctx.stroke();
    }
    if (person.id === selected && !reducedMotion) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 380);
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.r + 7 + pulse * 3, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(228, 197, 106, ${0.28 + pulse * 0.4})`;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    ctx.fillStyle = "#1a2414";
    ctx.font = `600 ${Math.max(11, Math.round(node.r * 0.58))}px Outfit, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initials(person.name), node.x, node.y + 0.5);
    ctx.font = "500 13px Outfit, sans-serif";
    ctx.fillStyle = "#f4f1e7";
    ctx.textBaseline = "top";
    ctx.fillText(shortName(person.name), node.x, node.y + node.r + 8);
    ctx.globalAlpha = 1;
  });

  if (!edges.length) {
    ctx.save();
    ctx.fillStyle = "rgba(244,241,231,0.82)";
    ctx.font = "500 14px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Partnerships you add will gather here", 0, positions.size ? 160 : 0);
    ctx.restore();
  }
}

function wake() {
  if (raf) return;
  const loop = () => {
    if (!state.ready) {
      raf = 0;
      return;
    }
    const pulsing = state.selectedId && !reducedMotion;
    if (energy > 0.02) step();
    draw();
    if (energy > 0.02 || pulsing) raf = requestAnimationFrame(loop);
    else raf = 0;
  };
  raf = requestAnimationFrame(loop);
}

function selectPerson(id) {
  state.selectedId = id;
  const person = personById(id);
  if (person && person.org === "tnc" && !document.querySelector("#tnc-name").value) {
    document.querySelector("#tnc-name").value = person.name;
  }
  if (person && person.org === "usfs" && !document.querySelector("#usfs-name").value) {
    document.querySelector("#usfs-name").value = person.name;
  }
  renderMine();
  renderDetail();
  wake();
}

let pointer = null;

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const world = toWorld(event.clientX, event.clientY);
  const hit = nodeAt(world);
  pointer = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    moved: false,
    nodeId: hit,
    pan: !hit,
  };
  if (hit) {
    const node = positions.get(hit);
    node.pin = true;
  }
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add("is-drag");
});

canvas.addEventListener("pointermove", (event) => {
  const world = toWorld(event.clientX, event.clientY);
  if (!pointer) {
    const hit = nodeAt(world);
    const edge = hit ? null : edgeAt(world);
    canvas.style.cursor = hit || edge ? "pointer" : "grab";
    if (edge) {
      const names = [personById(edge.from), personById(edge.to)].filter(Boolean).map((person) => person.name);
      const note = edge.reports[0];
      const extra = edge.reports.length > 1 ? ` +${edge.reports.length - 1} more` : "";
      tip.hidden = false;
      tip.textContent = `${names.join(" · ")} — ${note.place}. ${note.purpose}${extra}`;
      const rect = canvas.getBoundingClientRect();
      tip.style.left = `${event.clientX - rect.left + 12}px`;
      tip.style.top = `${event.clientY - rect.top + 12}px`;
    } else {
      tip.hidden = true;
    }
    return;
  }
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  if (Math.hypot(dx, dy) > 4) pointer.moved = true;
  if (pointer.nodeId) {
    const node = positions.get(pointer.nodeId);
    const previous = toWorld(pointer.x, pointer.y);
    node.x += world.x - previous.x;
    node.y += world.y - previous.y;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    userMoved = true;
    wake();
  } else if (pointer.pan && pointer.moved) {
    cam.x += dx / cam.k;
    cam.y += dy / cam.k;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    userMoved = true;
    draw();
  }
});

function endPointer(event) {
  if (!pointer || pointer.id !== event.pointerId) return;
  const world = toWorld(event.clientX, event.clientY);
  if (pointer.nodeId) {
    const node = positions.get(pointer.nodeId);
    if (node) node.pin = false;
    if (!pointer.moved) selectPerson(pointer.nodeId);
    else {
      energy = Math.max(energy, 0.7);
      wake();
    }
  } else if (!pointer.moved) {
    const edge = edgeAt(world);
    if (edge) {
      const pick = edge.from === state.selectedId ? edge.to : edge.from;
      selectPerson(pick);
    } else {
      selectPerson(null);
    }
  }
  pointer = null;
  canvas.classList.remove("is-drag");
  tip.hidden = true;
}

canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const before = toWorld(event.clientX, event.clientY);
  const next = Math.min(2.4, Math.max(0.35, cam.k * (event.deltaY > 0 ? 0.92 : 1.08)));
  cam.k = next;
  const after = toWorld(event.clientX, event.clientY);
  cam.x += after.x - before.x;
  cam.y += after.y - before.y;
  userMoved = true;
  draw();
}, { passive: false });

document.querySelector("#fit").addEventListener("click", () => fit(true));

window.addEventListener("resize", resize);

document.querySelector("#search").addEventListener("input", (event) => {
  state.query = event.target.value.trim().toLowerCase();
  const hits = state.people.filter(matches);
  if (state.query && hits.length === 1) selectPerson(hits[0].id);
  else wake();
});

document.body.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]");
  if (!action) return;
  const kind = action.dataset.action;
  if (kind === "focus") selectPerson(Number(action.dataset.id));
  if (kind === "clear") selectPerson(null);
  if (kind === "word") {
    const search = document.querySelector("#search");
    search.value = action.dataset.word;
    search.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (kind === "remove") {
    const name = action.dataset.name;
    try {
      const data = await api(`/api/connections/${action.dataset.id}`, { method: "DELETE" });
      applyNetwork(data);
      toast(`Removed ${name}`);
    } catch (error) {
      toast(error.message);
    }
  }
});

document.querySelector("#add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("#add-error", "");
  const tncName = document.querySelector("#tnc-name").value;
  const usfsName = document.querySelector("#usfs-name").value;
  const place = document.querySelector("#place").value;
  const purpose = document.querySelector("#purpose").value;
  const button = document.querySelector("#add-submit");
  button.disabled = true;
  try {
    const data = await api("/api/connections", {
      method: "POST",
      body: { tnc_name: tncName, usfs_name: usfsName, place, purpose },
    });
    document.querySelector("#tnc-name").value = "";
    document.querySelector("#usfs-name").value = "";
    document.querySelector("#purpose").value = "";
    state.selectedId = data.focus_id;
    applyNetwork(data);
    toast(data.message);
    document.querySelector("#tnc-name").focus();
  } catch (error) {
    showError("#add-error", error.message);
  } finally {
    button.disabled = false;
  }
});

document.addEventListener("keydown", (event) => {
  const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
  if (event.key === "Escape") {
    state.query = "";
    document.querySelector("#search").value = "";
    selectPerson(null);
  } else if (event.key === "/" && !typing) {
    event.preventDefault();
    document.querySelector("#tnc-name").focus();
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.ready) refresh().catch((error) => toast(error.message));
});

if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => draw());

api("/api/network")
  .then((data) => showApp(data))
  .catch((error) => {
    boot.textContent = error.message || "Canopy could not load.";
  });
