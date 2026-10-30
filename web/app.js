import { RaceSound } from "./sound.js";

const $ = (id) => document.getElementById(id);

const TYRES = {
  SOFT: { letter: "S", color: "#ff5a52" },
  MEDIUM: { letter: "M", color: "#ffd100" },
  HARD: { letter: "H", color: "#f6f4ee" },
  INTERMEDIATE: { letter: "I", color: "#45d07a" },
  WET: { letter: "W", color: "#5aa9ff" },
  UNKNOWN: { letter: "?", color: "#a3a6a9" },
};

const FILTERS = [
  { id: "key", label: "Key", empty: "No key moments in this race.", match: (m) => m.major },
  { id: "strategy", label: "Strategy", empty: "No undercuts or overcuts passed the checks in this race.", match: (m) => m.kind === "undercut" || m.kind === "overcut" },
  { id: "pass", label: "Passes", empty: "No on-track passes passed the checks in this race.", match: (m) => m.kind === "pass" },
  { id: "radio", label: "Radio", empty: "No team radio is available for this race.", match: (m) => m.kind === "radio" },
  { id: "all", label: "All", empty: "No moments found in this race.", match: () => true },
];

const STATUS_LABELS = { SC: "Safety car", VSC: "Virtual safety car", RED: "Red flag" };
const COLUMNS_WIDE = ["x", "y", "spd"];
const COLUMNS_NARROW = ["thr", "brk", "gear", "drs"];

const INK = "#ffffff";
const ASPHALT = "#11131a";
const TRACK_EDGE = "#ffffff";
const TRACK_SURFACE = "#3a3e4d";
const FLAG = "#ffd100";
const LAMP = "#ff2018";
const DARK_INK = "#0d0e12";
const FONT = "Saira, system-ui, sans-serif";

const PANEL_TICK_MS = 150;
const MOMENT_LEAD_IN = 8;
const MAX_FRAME_SECONDS = 0.25;
const LAMP_GAP_MS = 1000;
const MIN_HOLD_MS = 200;
const MAX_HOLD_MS = 3000;
const REACTION_WINDOW_MS = 1500;
const REACTION_SHOWN_MS = 5000;
const CAMERAS = ["overview", "chase", "onboard", "trackside", "helicopter"];
const ENGINE_MAX_SPEED = 2;
const OVERLAY_WIDTH = 900;
const CAPTION_MS = 4500;

const state = {
  races: [],
  race: null,
  t: 0,
  playing: false,
  speed: 4,
  selected: [],
  filter: "key",
  showAllLabels: true,
  view: "3d",
  camera: "chase",
  storyOpen: false,
  lastFrame: 0,
  lastPanels: 0,
  start: null,
};

let trackView = null;
let gapSeries = null;
let loadToken = 0;
let view3d = null;
let lastStatus = null;
const sound = new RaceSound();

// Picks black or white text, whichever reads better on a team colour.
function inkOn(hex) {
  const value = parseInt(hex.slice(1), 16);
  const channel = (shift) => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const light = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return light > 0.27 ? DARK_INK : "#ffffff";
}

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

function lastIndexAtOrBefore(values, t) {
  let low = 0;
  let high = values.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (values[mid] <= t) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function positionAt(driver, t) {
  const index = lastIndexAtOrBefore(driver.posTimes, t);
  return index >= 0 ? driver.pos[index][1] : 99;
}

function lapAt(driver, t) {
  return Math.max(lastIndexAtOrBefore(driver.laps, t) + 1, 1);
}

// Any one driver can have gaps in their lap data, so the race lap is the furthest anyone has reached.
function raceLap(t) {
  return Math.max(...state.race.drivers.map((driver) => lapAt(driver, t)));
}

function tyreAt(driver, t) {
  const lap = lapAt(driver, t);
  let current = null;
  for (const stint of driver.stints) {
    if (stint.from <= lap) current = stint;
  }
  if (!current) return { ...TYRES.UNKNOWN, compound: "UNKNOWN", age: 0, name: "unknown" };
  const tyre = TYRES[current.compound] ?? TYRES.UNKNOWN;
  return { ...tyre, compound: current.compound, age: current.age + lap - current.from, name: current.compound.toLowerCase() };
}

function gapAt(driver, t) {
  return driver.gaps[Math.floor(t / state.race.gapStep)] ?? null;
}

function isOut(driver, t) {
  return driver.retired_at !== null && t >= driver.retired_at;
}

function inPit(driver, t) {
  return driver.pits.some((stop) => t >= stop.t && t <= stop.t + (stop.lane ?? 24));
}

function statusAt(t) {
  return state.race.status.find((period) => t >= period.start && t <= period.end) ?? null;
}

// Catmull-Rom through the 1 Hz samples, so cars flow through corners instead of cutting straight lines.
function curve(values, index, last, blend) {
  const p0 = values[Math.max(index - 1, 0)];
  const p1 = values[index];
  const p2 = values[Math.min(index + 1, last)];
  const p3 = values[Math.min(index + 2, last)];
  const a = 2 * p1;
  const b = p2 - p0;
  const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
  const d = 3 * p1 - p0 - 3 * p2 + p3;
  return {
    value: 0.5 * (a + b * blend + c * blend * blend + d * blend * blend * blend),
    slope: 0.5 * (b + 2 * c * blend + 3 * d * blend * blend),
  };
}

function carAt(driver, t) {
  const last = driver.x.length - 1;
  const exact = Math.max(t / state.race.step, 0);
  const index = Math.min(Math.floor(exact), last);
  const blend = exact - index;
  const x = curve(driver.x, index, last, blend);
  const y = curve(driver.y, index, last, blend);
  return { x: x.value, y: y.value, dx: x.slope, dy: y.slope, index };
}

function resizeCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

function computeTrackView() {
  const { width, height } = resizeCanvas($("track"));
  const { x, y } = state.race.track;
  const [minX, maxX] = [Math.min(...x), Math.max(...x)];
  const [minY, maxY] = [Math.min(...y), Math.max(...y)];
  // The full map keeps clear of the overlays, and the minimap only needs a small margin.
  const overlaid = state.view === "map" && window.innerWidth >= OVERLAY_WIDTH;
  const inset = state.view === "3d" ? { left: 14, right: 14, top: 14, bottom: 14 }
    : overlaid ? { left: 270, right: 40, top: 80, bottom: 130 } : { left: 44, right: 44, top: 60, bottom: 44 };
  const scale = Math.min((width - inset.left - inset.right) / (maxX - minX), (height - inset.top - inset.bottom) / (maxY - minY));
  const offsetX = inset.left + (width - inset.left - inset.right - (maxX - minX) * scale) / 2;
  const offsetY = inset.bottom + (height - inset.top - inset.bottom - (maxY - minY) * scale) / 2;
  const project = (px, py) => [offsetX + (px - minX) * scale, height - offsetY - (py - minY) * scale];
  const path = new Path2D();
  x.forEach((px, index) => {
    const [cx, cy] = project(px, y[index]);
    if (index) path.lineTo(cx, cy);
    else path.moveTo(cx, cy);
  });
  path.closePath();
  const [startX, startY] = project(x[0], y[0]);
  const [nextX, nextY] = project(x[2], y[2]);
  trackView = { width, height, project, path, start: [startX, startY, Math.atan2(nextY - startY, nextX - startX)] };
}

function focusDriver() {
  return selectedDrivers()[0] ?? runningOrder(state.t)[0];
}

function drawTrack() {
  const mini = state.view === "3d";
  if (mini) view3d?.render(state.t, state.selected, statusAt(state.t), state.showAllLabels);
  if (!trackView) return;
  const context = $("track").getContext("2d");
  const { width, height, path, start } = trackView;
  context.clearRect(0, 0, width, height);
  context.lineJoin = "round";
  context.lineCap = "round";
  context.strokeStyle = TRACK_EDGE;
  context.lineWidth = mini ? 4 : 12;
  context.stroke(path);
  context.strokeStyle = TRACK_SURFACE;
  context.lineWidth = mini ? 2 : 8;
  context.stroke(path);

  const status = statusAt(state.t);
  if (status) {
    context.strokeStyle = status.kind === "RED" ? LAMP : FLAG;
    context.lineWidth = mini ? 2 : 3;
    context.stroke(path);
  }

  context.save();
  context.translate(start[0], start[1]);
  context.rotate(start[2]);
  context.fillStyle = INK;
  context.fillRect(-2, mini ? -5 : -9, mini ? 3 : 4, mini ? 10 : 18);
  context.restore();

  const cars = state.race.drivers
    .filter((driver) => !isOut(driver, state.t))
    .map((driver) => ({ driver, position: positionAt(driver, state.t), selected: state.selected.includes(driver.num) }))
    .sort((a, b) => Number(a.selected) - Number(b.selected) || b.position - a.position);

  const labels = [];
  for (const { driver, selected, position } of cars) {
    const car = carAt(driver, state.t);
    const [cx, cy] = trackView.project(car.x, car.y);
    const faded = state.selected.length > 0 && !selected;
    if (!mini && (selected || (state.showAllLabels && !faded) || position <= 3)) {
      labels.push({ text: driver.code, cx, cy, faded });
    }
    context.globalAlpha = faded ? 0.5 : 1;
    context.beginPath();
    context.arc(cx, cy, mini ? (selected ? 5 : 3.5) : selected ? 9 : 7, 0, Math.PI * 2);
    context.fillStyle = driver.color;
    context.fill();
    context.lineWidth = mini ? 1 : 2;
    context.strokeStyle = selected ? INK : ASPHALT;
    context.stroke();
    context.globalAlpha = 1;
  }
  drawLabels(context, labels.reverse());
}

// Labels arrive most important first, and any that would overlap a placed label are skipped.
function drawLabels(context, labels) {
  context.font = `700 13px ${FONT}`;
  context.textBaseline = "middle";
  const placed = [];
  for (const { text, cx, cy, faded } of labels) {
    const box = { x: cx + 9, y: cy - 17, w: 30, h: 15 };
    const clashes = placed.some((other) => box.x < other.x + other.w && other.x < box.x + box.w
      && box.y < other.y + other.h && other.y < box.y + box.h);
    if (clashes) continue;
    placed.push(box);
    context.globalAlpha = faded ? 0.7 : 1;
    context.lineWidth = 3;
    context.strokeStyle = ASPHALT;
    context.strokeText(text, cx + 9, cy - 9);
    context.fillStyle = INK;
    context.fillText(text, cx + 9, cy - 9);
  }
  context.globalAlpha = 1;
}

function runningOrder(t) {
  return [...state.race.drivers].sort((a, b) => {
    const outA = isOut(a, t);
    const outB = isOut(b, t);
    if (outA !== outB) return outA ? 1 : -1;
    return positionAt(a, t) - positionAt(b, t);
  });
}

function buildLeaderboard() {
  const list = $("leaderboard");
  list.replaceChildren();
  for (const driver of state.race.drivers) {
    const item = document.createElement("li");
    const row = document.createElement("button");
    row.type = "button";
    row.className = "row";
    row.innerHTML = `<span class="pos"></span><span class="code"></span><span class="tyre"></span><span class="gap"></span>`;
    row.style.setProperty("--team", driver.color);
    row.style.setProperty("--on-team", inkOn(driver.color));
    row.querySelector(".code").textContent = driver.code;
    row.setAttribute("aria-label", driver.name);
    row.addEventListener("click", () => toggleDriver(driver.num));
    item.append(row);
    driver.row = row;
    list.append(item);
  }
}

function updateLeaderboard() {
  const t = state.t;
  const list = $("leaderboard");
  const order = runningOrder(t);
  const leaderLap = lapAt(order[0], t);
  order.forEach((driver, index) => {
    const row = driver.row;
    const out = isOut(driver, t);
    const tyre = tyreAt(driver, t);
    const gap = gapAt(driver, t);
    const selected = state.selected.includes(driver.num);
    row.classList.toggle("out", out);
    row.classList.toggle("selected", selected);
    row.setAttribute("aria-pressed", String(selected));
    row.querySelector(".pos").textContent = out ? "" : index + 1;
    const badge = row.querySelector(".tyre");
    badge.textContent = out ? "" : tyre.letter;
    badge.style.background = out ? "transparent" : tyre.color;
    badge.title = out ? "" : `${tyre.name} tyre, ${tyre.age} laps old`;
    let label = "";
    if (out) label = "Out";
    else if (inPit(driver, t)) label = "Pit";
    else if (index === 0) label = "Leader";
    else if (gap !== null) label = `+${gap.toFixed(1)}`;
    else if (lapAt(driver, t) < leaderLap) label = "Lapped";
    row.querySelector(".gap").textContent = label;
    if (list.children[index] !== row.parentElement) list.insertBefore(row.parentElement, list.children[index]);
  });
}

function buildFilters() {
  const holder = $("filters");
  holder.replaceChildren();
  for (const filter of FILTERS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = filter.label;
    button.setAttribute("aria-pressed", String(filter.id === state.filter));
    button.addEventListener("click", () => {
      state.filter = filter.id;
      holder.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      buildMoments();
    });
    holder.append(button);
  }
}

function activeFilter() {
  return FILTERS.find((candidate) => candidate.id === state.filter);
}

function visibleMoments() {
  return state.race.moments.filter(activeFilter().match);
}

function buildMoments() {
  const list = $("moments");
  list.replaceChildren();
  const moments = visibleMoments();
  if (!moments.length) {
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = activeFilter().empty;
    list.append(item);
  }
  for (const moment of moments) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "moment";
    button.dataset.kind = moment.kind;
    button.innerHTML = `<span class="when"></span><span><span class="name"></span><span class="detail"></span></span>`;
    button.querySelector(".when").textContent = `Lap ${raceLap(moment.t)}`;
    button.querySelector(".name").textContent = moment.title;
    button.querySelector(".detail").textContent = moment.detail;
    button.addEventListener("click", () => jumpToMoment(moment));
    moment.element = button;
    item.append(button);
    list.append(item);
  }
  updateMoments(true);
}

function updateMoments(force = false) {
  let current = null;
  for (const moment of visibleMoments()) {
    const past = moment.t <= state.t;
    moment.element?.classList.toggle("past", past);
    moment.element?.classList.remove("current");
    if (past) current = moment;
  }
  announce(current);
  if (!current?.element) return;
  current.element.classList.add("current");
  if (force || state.playing) {
    // scrollIntoView would also move the page on a phone, so only the list scrolls.
    const list = $("moments");
    const top = current.element.offsetTop;
    if (top < list.scrollTop || top + current.element.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top - list.clientHeight / 2;
    }
  }
}

// During playback, new moments appear as a caption over the race, like a TV graphic.
function announce(moment) {
  if (moment === state.announced) return;
  const wasPlaying = state.announced !== undefined && state.playing;
  state.announced = moment;
  if (!moment || !wasPlaying) return;
  $("lower-title").textContent = moment.title;
  $("lower-detail").textContent = moment.detail;
  $("lower-third").dataset.kind = moment.kind;
  $("lower-third").hidden = false;
  clearTimeout(announce.timer);
  announce.timer = setTimeout(() => { $("lower-third").hidden = true; }, CAPTION_MS);
}

function jumpToMoment(moment) {
  cancelStart();
  if (moment.url) {
    state.selected = moment.drivers.slice(0, 1);
    seek(moment.t);
    onSelectionChanged();
    sound.playRadio(moment.url).then((played) => {
      if (!played) showReaction("This team radio clip is no longer available from Formula 1.");
    });
    return;
  }
  state.selected = moment.drivers.slice(0, 2);
  seek(Math.max(moment.t - MOMENT_LEAD_IN, 0));
  onSelectionChanged();
}

function stepMoment(direction) {
  const moments = visibleMoments();
  const target = direction > 0
    ? moments.find((moment) => moment.t - MOMENT_LEAD_IN > state.t + 1)
    : [...moments].reverse().find((moment) => moment.t - MOMENT_LEAD_IN < state.t - 1);
  if (target) jumpToMoment(target);
}

function buildTimeline() {
  const { duration, status, moments } = state.race;
  const bands = $("bands");
  bands.replaceChildren();
  for (const period of status) {
    const band = document.createElement("div");
    band.className = `band ${period.kind.toLowerCase()}`;
    band.style.left = `${(period.start / duration) * 100}%`;
    band.style.width = `${((period.end - period.start) / duration) * 100}%`;
    bands.append(band);
  }
  const ticks = $("ticks");
  ticks.replaceChildren();
  for (const moment of moments.filter((m) => m.major || m.kind === "undercut" || m.kind === "overcut")) {
    const tick = document.createElement("div");
    tick.className = `tick${moment.major ? " major" : ""}`;
    tick.style.left = `${(moment.t / duration) * 100}%`;
    ticks.append(tick);
  }
}

function toggleDriver(number) {
  if (state.selected.includes(number)) {
    state.selected = state.selected.filter((value) => value !== number);
  } else {
    state.selected = [...state.selected, number].slice(-2);
  }
  onSelectionChanged();
}

function onSelectionChanged() {
  $("replay").classList.toggle("no-compare", state.selected.length === 0);
  buildGapSeries();
  updateCards();
  computeTrackView();
  view3d?.resize();
  updateLeaderboard();
  drawGapChart();
  drawTrack();
  syncUrl();
}

function selectedDrivers() {
  return state.selected.map((number) => state.race.drivers.find((d) => d.num === number)).filter(Boolean);
}

function updateCards() {
  const holder = $("driver-cards");
  const drivers = selectedDrivers();
  const title = $("focus-title");
  if (drivers.length === 0) {
    title.textContent = "Compare two drivers";
    holder.innerHTML = `<p class="card-empty">Pick two drivers from the running order, or choose a moment from the race story.</p>`;
    return;
  }
  title.textContent = drivers.map((driver) => driver.name).join(" and ");
  if (holder.children.length !== drivers.length || holder.querySelector(".card-empty")) {
    holder.replaceChildren(...drivers.map(() => {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<div class="card-name c-team"></div>
        <div class="speed-value"><span class="c-speed"></span> <small>km/h</small></div>
        <div class="meters">
          <div class="meter">Throttle<div><span class="c-thr"></span></div></div>
          <div class="meter">Brake<div><span class="c-brk"></span></div></div>
        </div>
        <div class="card-foot c-foot"></div>`;
      return card;
    }));
  }
  drivers.forEach((driver, position) => {
    const card = holder.children[position];
    const { index } = carAt(driver, state.t);
    const tyre = tyreAt(driver, state.t);
    card.style.setProperty("--team", driver.color);
    card.style.setProperty("--on-team", inkOn(driver.color));
    card.querySelector(".c-team").textContent = `${driver.code}, ${driver.team}`;
    card.querySelector(".c-speed").textContent = driver.spd[index];
    card.querySelector(".c-thr").style.width = `${driver.thr[index]}%`;
    card.querySelector(".c-brk").style.width = `${driver.brk[index]}%`;
    const drs = driver.drs[index] ? ", DRS open" : "";
    card.querySelector(".c-foot").textContent =
      `P${positionAt(driver, state.t)}, gear ${driver.gear[index]}${drs}, ${tyre.name} tyre ${tyre.age} laps old`;
  });
}

// Positive means the first driver is ahead of the second one.
function buildGapSeries() {
  const drivers = selectedDrivers();
  $("gap-wrap").hidden = drivers.length !== 2;
  gapSeries = null;
  if (drivers.length !== 2) return;
  const [first, second] = drivers;
  const values = first.gaps.map((gap, index) => {
    const other = second.gaps[index];
    return gap === null || other === null ? null : other - gap;
  });
  gapSeries = { first, second, values };
  $("gap-title").textContent = `Seconds between them, above the line means ${first.code} is ahead`;
}

function drawGapChart() {
  if (!gapSeries) return;
  const { context, width, height } = resizeCanvas($("gap-chart"));
  const { values } = gapSeries;
  const known = values.filter((value) => value !== null);
  context.clearRect(0, 0, width, height);
  if (!known.length) return;
  const limit = Math.max(1, Math.min(60, Math.max(...known.map(Math.abs))));
  const left = 34;
  const right = 6;
  const top = 8;
  const bottom = 8;
  const xOf = (index) => left + (index / (values.length - 1)) * (width - left - right);
  const yOf = (value) => top + ((limit - Math.max(-limit, Math.min(limit, value))) / (2 * limit)) * (height - top - bottom);

  context.font = `500 13px ${FONT}`;
  context.textBaseline = "middle";
  context.textAlign = "right";
  context.fillStyle = "#c9cacb";
  context.strokeStyle = "#54585d";
  context.lineWidth = 1;
  for (const value of [limit, 0, -limit]) {
    const y = yOf(value);
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(width - right, y);
    context.stroke();
    context.fillText(`${value > 0 ? "+" : ""}${Math.round(value)}`, left - 6, y);
  }
  context.textAlign = "left";

  // The line takes the colour of whichever driver is ahead.
  context.lineWidth = 2.5;
  context.lineJoin = "round";
  for (const [driver, ahead] of [[gapSeries.first, (value) => value >= 0], [gapSeries.second, (value) => value < 0]]) {
    context.strokeStyle = gapSeries.first.color === gapSeries.second.color && driver === gapSeries.second ? INK : driver.color;
    context.beginPath();
    let drawing = false;
    values.forEach((value, index) => {
      if (value === null || !ahead(value)) {
        drawing = false;
        return;
      }
      if (drawing) context.lineTo(xOf(index), yOf(value));
      else context.moveTo(xOf(index), yOf(value));
      drawing = true;
    });
    context.stroke();
  }

  const nowX = xOf(Math.min(state.t / state.race.gapStep, values.length - 1));
  context.strokeStyle = LAMP;
  context.beginPath();
  context.moveTo(nowX, top);
  context.lineTo(nowX, height - bottom);
  context.stroke();
  gapSeries.hit = { left, right, width };
}

function gapIndexFromEvent(event) {
  const { left, right, width } = gapSeries.hit;
  const box = event.currentTarget.getBoundingClientRect();
  const ratio = (event.clientX - box.left - left) / (width - left - right);
  return Math.max(0, Math.min(gapSeries.values.length - 1, Math.round(ratio * (gapSeries.values.length - 1))));
}

function wireGapChart() {
  const canvas = $("gap-chart");
  const tooltip = $("gap-tooltip");
  canvas.addEventListener("pointermove", (event) => {
    if (!gapSeries?.hit) return;
    const index = gapIndexFromEvent(event);
    const value = gapSeries.values[index];
    const lap = lapAt(gapSeries.first, index * state.race.gapStep);
    tooltip.textContent = value === null
      ? `Lap ${lap}, no gap available`
      : `Lap ${lap}, ${value >= 0 ? gapSeries.first.code : gapSeries.second.code} ahead by ${Math.abs(value).toFixed(1)}s`;
    tooltip.hidden = false;
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    tooltip.style.left = `${x > box.width - 210 ? x - 210 : x + 12}px`;
    tooltip.style.top = "24px";
  });
  canvas.addEventListener("pointerleave", () => { tooltip.hidden = true; });
  canvas.addEventListener("click", (event) => {
    if (gapSeries?.hit) seek(gapIndexFromEvent(event) * state.race.gapStep);
  });
}

function updateClock() {
  const t = state.t;
  const leader = runningOrder(t)[0];
  const total = state.race.meta.laps;
  if (state.leaderNum !== leader.num) {
    state.leaderNum = leader.num;
    const head = document.querySelector(".head");
    head.style.setProperty("--leader", leader.color);
    head.style.setProperty("--on-leader", inkOn(leader.color));
    $("leader-note").textContent = `${leader.name} leads, ${leader.team}`;
  }
  const lap = Math.min(raceLap(t), total || Infinity);
  $("lap-now").textContent = lap;
  $("lap-total").textContent = total ? `of ${total}` : "";
  $("time-label").textContent = formatClock(t);
  const status = statusAt(t);
  const badge = $("status-badge");
  badge.hidden = !status;
  if (status) {
    badge.textContent = STATUS_LABELS[status.kind];
    badge.className = `status-badge ${status.kind.toLowerCase()}`;
  }
  const percent = (t / state.race.duration) * 100;
  $("fill").style.width = `${percent}%`;
  $("head").style.left = `${percent}%`;
  $("timeline").setAttribute("aria-valuenow", String(Math.round(percent)));
  $("timeline").setAttribute("aria-valuetext", `Lap ${lap}, ${formatClock(t)}`);
}

function updateSound() {
  const status = statusAt(state.t)?.kind ?? null;
  if (status !== lastStatus) {
    if (status) sound.cheer();
    lastStatus = status;
  }
  if (!state.race) return;
  const driver = focusDriver();
  const { index, x } = carAt(driver, state.t);
  const out = isOut(driver, state.t);
  const close = state.view === "3d" && view3d ? view3d.presence() : 0.3;
  sound.update({
    running: state.playing && !out,
    speed: driver.spd[index],
    gear: driver.gear[index],
    throttle: driver.thr[index],
    pan: ((x - state.race.minX) / (state.race.maxX - state.race.minX || 1)) * 2 - 1,
    // Telemetry changes too quickly to follow at high replay speeds, so those fall back to trackside sound.
    presence: state.speed > ENGINE_MAX_SPEED ? 0 : close,
  });
  playDueRadio();
  if (state.t >= state.race.duration - 1) sound.finish();
}

// During playback, team radio plays at the moment it was sent.
function playDueRadio() {
  const previous = state.lastRadioCheck;
  state.lastRadioCheck = state.t;
  if (!sound.enabled || !state.playing || state.speed > ENGINE_MAX_SPEED || previous === undefined) return;
  const clip = state.race.moments.find((moment) => moment.url && moment.t > previous && moment.t <= state.t);
  if (clip) sound.playRadio(clip.url);
}

function refresh() {
  drawTrack();
  updateClock();
  updateLeaderboard();
  updateCards();
  updateMoments();
  drawGapChart();
}

function seek(t) {
  state.t = Math.max(0, Math.min(t, state.race.duration));
  refresh();
  syncUrl();
}

function setPlaying(playing) {
  const wasPlaying = state.playing;
  state.playing = playing;
  $("play").textContent = playing ? "Pause" : "Play";
  state.lastFrame = performance.now();
  if (playing && !wasPlaying) requestAnimationFrame(tick);
  if (!playing) {
    if (state.race) syncUrl();
    sound.update({ running: false });
  }
}

// The loop only runs during playback, so a paused replay costs no CPU or battery.
function tick(now) {
  if (!state.race || !state.playing) return;
  state.t += Math.min((now - state.lastFrame) / 1000, MAX_FRAME_SECONDS) * state.speed;
  state.lastFrame = now;
  if (state.t >= state.race.duration) {
    state.t = state.race.duration;
    setPlaying(false);
  }
  drawTrack();
  updateClock();
  if (now - state.lastPanels > PANEL_TICK_MS) {
    state.lastPanels = now;
    updateSound();
    updateLeaderboard();
    updateMoments();
    updateCards();
    drawGapChart();
  }
  if (state.playing) requestAnimationFrame(tick);
}

function clearStartTimers() {
  state.start?.timers.forEach(clearTimeout);
}

function cancelStart() {
  clearStartTimers();
  state.start = null;
  $("gantry").hidden = true;
  view3d?.setLamps(0);
}

function showReaction(message) {
  const reaction = $("reaction");
  reaction.textContent = message;
  reaction.hidden = false;
  clearTimeout(showReaction.timer);
  showReaction.timer = setTimeout(() => { reaction.hidden = true; }, REACTION_SHOWN_MS);
}

// Five lamps, one a second, then a random hold, the same way a real grid start works.
function runStart() {
  const lamps = [...document.querySelectorAll("#gantry .lamps i")];
  lamps.forEach((lamp) => lamp.classList.remove("on"));
  $("gantry").hidden = false;
  $("gantry").classList.toggle("over-scene", state.view === "3d");
  $("gantry-note").textContent = "Press space or tap when the lights go out";
  $("skip-start").hidden = false;
  const start = { timers: [], outAt: null };
  state.start = start;
  lamps.forEach((lamp, index) => {
    start.timers.push(setTimeout(() => {
      lamp.classList.add("on");
      view3d?.setLamps(index + 1);
      sound.lamp();
      drawTrack();
    }, (index + 1) * LAMP_GAP_MS));
  });
  const hold = MIN_HOLD_MS + Math.random() * (MAX_HOLD_MS - MIN_HOLD_MS);
  start.timers.push(setTimeout(() => {
    lamps.forEach((lamp) => lamp.classList.remove("on"));
    start.outAt = performance.now();
    $("gantry").hidden = true;
    view3d?.setLamps(0);
    sound.lightsOut();
    setPlaying(true);
    start.timers.push(setTimeout(() => { if (state.start === start) state.start = null; }, REACTION_WINDOW_MS));
  }, lamps.length * LAMP_GAP_MS + hold));
}

// Returns true when the press was used by the start sequence.
function pressDuringStart() {
  const start = state.start;
  if (!start) return false;
  const pressed = performance.now();
  cancelStart();
  if (start.outAt === null) {
    showReaction("Jump start. Wait for every light to go out.");
    setPlaying(true);
  } else {
    const seconds = (pressed - start.outAt) / 1000;
    showReaction(`Your reaction: ${seconds.toFixed(3)}s. F1 drivers manage about 0.2s.`);
  }
  return true;
}

function togglePlay() {
  if (pressDuringStart()) return;
  if (!state.playing && state.t < 1) {
    runStart();
    return;
  }
  setPlaying(!state.playing);
}

function syncUrl() {
  if (state.race) history.replaceState({ race: state.race.meta.slug }, "", shareUrl());
}

function shareUrl() {
  const url = new URL(location.href);
  url.searchParams.set("race", state.race.meta.slug);
  url.searchParams.set("t", String(Math.round(state.t)));
  if (state.selected.length) url.searchParams.set("drivers", selectedDrivers().map((d) => d.code).join(","));
  else url.searchParams.delete("drivers");
  if (state.view === "3d") {
    url.searchParams.delete("view");
    url.searchParams.set("camera", state.camera);
  } else {
    url.searchParams.set("view", "map");
    url.searchParams.delete("camera");
  }
  return url;
}

function wireTimeline() {
  const timeline = $("timeline");
  const seekFromEvent = (event) => {
    const box = timeline.getBoundingClientRect();
    seek(((event.clientX - box.left) / box.width) * state.race.duration);
  };
  timeline.addEventListener("pointerdown", (event) => {
    cancelStart();
    timeline.setPointerCapture(event.pointerId);
    seekFromEvent(event);
  });
  timeline.addEventListener("pointermove", (event) => {
    if (timeline.hasPointerCapture(event.pointerId)) seekFromEvent(event);
  });
}

function pressSwitch(holder, active) {
  holder.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button === active)));
}

function setCamera(camera) {
  state.camera = camera;
  pressSwitch($("camera-switch"), $("camera-switch").querySelector(`[data-camera="${camera}"]`));
  view3d?.setCamera(camera);
  drawTrack();
  syncUrl();
}

// Three.js only downloads the first time someone opens the 3D view.
async function setView(view) {
  if (view === "3d" && !view3d) {
    $("view-3d").textContent = "Loading";
    $("loading").hidden = false;
    $("loading").textContent = "Building the circuit";
    try {
      const { createView3D } = await import("./view3d.min.js");
      view3d = createView3D($("scene"), {
        carAt,
        isOut,
        positionAt,
        tyreAt,
        focus: focusDriver,
      });
    } catch {
      view = "map";
      showReaction("The 3D view needs WebGL, which this browser has turned off. The map still works.");
    }
    $("view-3d").textContent = "3D";
  }
  state.view = view;
  const is3d = view === "3d";
  $("replay").classList.toggle("in-3d", is3d);
  $("scene").hidden = !is3d;
  $("camera-switch").hidden = !is3d;
  $("height-note").hidden = !is3d;
  pressSwitch($("view-map").parentElement, is3d ? $("view-3d") : $("view-map"));
  if (state.race) {
    // Let the browser paint the loading message before the circuit is built.
    if (is3d) {
      await new Promise(requestAnimationFrame);
      view3d.setRace(state.race);
      view3d.setCamera(state.camera);
      pressSwitch($("camera-switch"), $("camera-switch").querySelector(`[data-camera="${state.camera}"]`));
    }
    computeTrackView();
    $("loading").hidden = true;
    drawTrack();
    syncUrl();
  }
}

async function toggleSound() {
  const on = !sound.enabled;
  const button = $("sound");
  button.textContent = on ? "Loading" : "Sound off";
  try {
    await sound.setEnabled(on);
  } catch {
    await sound.setEnabled(false);
    showReaction("The sound files did not load. Check your connection and try again.");
    button.textContent = "Sound off";
    return;
  }
  button.textContent = on ? "Sound on" : "Sound off";
  button.setAttribute("aria-pressed", String(on));
  $("volume-box").hidden = !on;
  if (on && state.speed > ENGINE_MAX_SPEED) showReaction("Trackside sound at this speed. Choose 1× or 2× to ride with the engine and hear team radio.");
  if (on && state.race) updateSound();
}

function setStoryOpen(open) {
  state.storyOpen = open;
  document.querySelector(".story").classList.toggle("open", open);
  $("story-toggle").setAttribute("aria-pressed", String(open));
}

function wireControls() {
  $("story-toggle").addEventListener("click", () => setStoryOpen(!state.storyOpen));
  $("clear-drivers").addEventListener("click", () => {
    state.selected = [];
    onSelectionChanged();
  });
  $("volume").addEventListener("input", (event) => sound.setVolume(Number(event.target.value)));
  $("view-map").addEventListener("click", () => setView("map"));
  $("view-3d").addEventListener("click", () => setView("3d"));
  $("sound").addEventListener("click", toggleSound);
  $("camera-switch").addEventListener("click", (event) => {
    const camera = event.target.closest("button")?.dataset.camera;
    if (camera) setCamera(camera);
  });
  $("play").addEventListener("click", togglePlay);
  $("back").addEventListener("click", () => seek(state.t - 10));
  $("forward").addEventListener("click", () => { cancelStart(); seek(state.t + 10); });
  $("prev-moment").addEventListener("click", () => stepMoment(-1));
  $("next-moment").addEventListener("click", () => stepMoment(1));
  $("speed").addEventListener("change", (event) => { state.speed = Number(event.target.value); });
  $("to-races").addEventListener("click", () => {
    history.pushState({}, "", location.pathname);
    showPicker();
  });
  $("gantry").addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#skip-start")) pressDuringStart();
  });
  $("skip-start").addEventListener("click", () => {
    cancelStart();
    setPlaying(true);
  });
  $("share").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(shareUrl().href);
      button.textContent = "Link copied";
    } catch {
      button.textContent = "Copy it from the address bar";
    }
    setTimeout(() => { button.textContent = "Copy link"; }, 1800);
  });
  window.addEventListener("resize", () => {
    if (!state.race || $("replay").hidden) return;
    computeTrackView();
    view3d?.resize();
    refresh();
  });
  window.addEventListener("popstate", route);
  document.addEventListener("keydown", (event) => {
    if ($("replay").hidden || !state.race || event.target.matches("select, input")) return;
    if (event.code === "Space") {
      event.preventDefault();
      if (!event.repeat) togglePlay();
    } else if (event.key === "ArrowLeft") {
      seek(state.t - 10);
    } else if (event.key === "ArrowRight") {
      seek(state.t + 10);
    } else if (event.key === "n") {
      stepMoment(1);
    } else if (event.key === "p") {
      stepMoment(-1);
    } else if (event.key === "v") {
      setView(state.view === "3d" ? "map" : "3d");
    } else if (event.key === "c" && state.view === "3d") {
      setCamera(CAMERAS[(CAMERAS.indexOf(state.camera) + 1) % CAMERAS.length]);
    } else if (event.key === "m") {
      toggleSound();
    } else if (event.key === "s") {
      setStoryOpen(!state.storyOpen);
    } else if (event.key === "l") {
      state.showAllLabels = !state.showAllLabels;
      drawTrack();
    }
  });
}

// Each column holds one delta-encoded series per driver, see src/lightsout/pack.py.
async function loadFrames(slug, race) {
  const response = await fetch(`data/${slug}.frames.gz`);
  if (!response.ok) throw new Error(`frames returned ${response.status}`);
  let buffer = await response.arrayBuffer();
  const magic = new Uint8Array(buffer, 0, 2);
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    buffer = await new Response(stream).arrayBuffer();
  }
  let offset = 0;
  const readColumn = (Type, name) => {
    for (const driver of race.drivers) {
      const values = new Type(buffer, offset, race.frames);
      for (let index = 1; index < values.length; index += 1) values[index] += values[index - 1];
      driver[name] = values;
      offset += race.frames * Type.BYTES_PER_ELEMENT;
    }
  };
  COLUMNS_WIDE.forEach((name) => readColumn(Int16Array, name));
  COLUMNS_NARROW.forEach((name) => readColumn(Int8Array, name));
}

async function loadRace(slug, startAt = 0, driverCodes = [], view = state.view, camera = state.camera) {
  const token = ++loadToken;
  cancelStart();
  setPlaying(false);
  state.race = null;
  trackView = null;
  $("picker").hidden = true;
  $("replay").hidden = false;
  const loading = $("loading");
  loading.hidden = false;
  loading.textContent = "Loading race";
  try {
    const response = await fetch(`data/${slug}.json`);
    if (!response.ok) throw new Error(`race returned ${response.status}`);
    const race = await response.json();
    await loadFrames(slug, race);
    if (token !== loadToken) return;
    for (const driver of race.drivers) driver.posTimes = driver.pos.map((change) => change[0]);
    race.minX = Math.min(...race.track.x);
    race.maxX = Math.max(...race.track.x);
    state.race = race;
  } catch (error) {
    if (token === loadToken) loading.textContent = `This race did not load (${error.message}). Check your connection and reload the page.`;
    return;
  }
  loading.hidden = true;
  state.t = Math.max(0, Math.min(startAt, state.race.duration));
  state.selected = state.race.drivers.filter((d) => driverCodes.includes(d.code)).map((d) => d.num);
  state.filter = "key";
  state.leaderNum = null;
  state.announced = undefined;
  $("lower-third").hidden = true;
  state.lastRadioCheck = undefined;
  const { name, year } = state.race.meta;
  document.title = `${year} ${name}, Lights Out`;
  $("race-title").textContent = `${year} ${name}`;
  buildLeaderboard();
  buildFilters();
  buildMoments();
  buildTimeline();
  state.camera = CAMERAS.includes(camera) ? camera : "overview";
  await setView(view);
  if (token !== loadToken) return;
  onSelectionChanged();
  refresh();
  lastStatus = statusAt(state.t)?.kind ?? null;
}

function formatDate(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}

function circuitCard(race) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "circuit";
  if (race.winnerColor) {
    button.style.setProperty("--team", race.winnerColor);
    button.style.setProperty("--on-team", inkOn(race.winnerColor));
  }
  const outline = race.outline
    ? `<svg viewBox="0 0 100 100" aria-hidden="true"><path class="base" d="${race.outline}"/><path class="lap" pathLength="1" d="${race.outline}"/></svg>`
    : "";
  button.innerHTML = `${outline}<strong></strong><span class="when"></span><span class="won"></span>`;
  button.querySelector("strong").textContent = race.name;
  button.querySelector(".when").textContent = formatDate(race.date);
  button.querySelector(".won").textContent = race.winner ? `Won by ${race.winner}` : "";
  button.addEventListener("click", () => {
    history.pushState({}, "", `?race=${race.slug}`);
    loadRace(race.slug);
  });
  return button;
}

function showPicker() {
  loadToken += 1;
  cancelStart();
  state.race = null;
  setPlaying(false);
  document.title = "Lights Out";
  $("replay").hidden = true;
  $("picker").hidden = false;
  window.scrollTo(0, 0);
}

function buildPicker() {
  const holder = $("seasons");
  const years = [...new Set(state.races.map((race) => race.year))];
  holder.replaceChildren(...years.map((year) => {
    const section = document.createElement("section");
    section.className = "season";
    const heading = document.createElement("h2");
    heading.textContent = year;
    const grid = document.createElement("div");
    grid.className = "circuits";
    grid.append(...state.races.filter((race) => race.year === year).map(circuitCard));
    section.append(heading, grid);
    return section;
  }));
}

function route() {
  const params = new URLSearchParams(location.search);
  const slug = params.get("race");
  if (state.races.some((race) => race.slug === slug)) {
    loadRace(slug, Number(params.get("t")) || 0, (params.get("drivers") ?? "").split(","),
      params.get("view") === "map" ? "map" : "3d", params.get("camera") ?? state.camera);
  } else {
    showPicker();
  }
}

async function start() {
  wireControls();
  wireTimeline();
  wireGapChart();
  try {
    const response = await fetch("data/index.json");
    if (!response.ok) throw new Error(`race list returned ${response.status}`);
    state.races = (await response.json()).races;
    buildPicker();
    route();
  } catch (error) {
    $("picker").hidden = false;
    const message = document.createElement("p");
    message.className = "picker-error";
    message.textContent = `The race list did not load (${error.message}). Check your connection and reload the page.`;
    $("seasons").replaceChildren(message);
  }
}

start();
