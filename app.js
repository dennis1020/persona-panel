/*
 * Synthetic Consumer Panel
 * ------------------------
 * 1. Settings  -> a panel of personas (age group x factor levels x condition x n per cell)
 * 2. For each persona, fill the prompt template and call the Claude Messages API once
 * 3. Parse the JSON answer into 1-7 scores and keep the request + raw answer
 * 4. Compare conditions with Welch's t-test, overall and by subgroup
 *
 * Everything runs in the browser. The API key goes only to api.anthropic.com.
 */
"use strict";

/* ===================== 1. Default settings ===================== */

const DEFAULT_TEMPLATE = `You are a real consumer with this profile:
{profile}
Stay in this person's perspective. Answer the way they honestly would.
There is no right answer, and strong reactions in either direction are fine.

You are scrolling social media and see this ad:
---
{ad}
---

Rate each from 1 (not at all) to 7 (very much):
1. How much do you trust this ad?
2. How likely are you to buy this product?
3. How authentic does this ad feel?
Then give one sentence explaining your reaction.

Reply with only this JSON object and no other text before or after it:
{"trust": _, "purchase_intent": _, "authenticity": _, "reason": "_"}`;

const DEFAULTS = {
  model: "claude-haiku-5-5",
  temperature: 1,
  maxTokens: 1000,
  perCell: 10,
  concurrency: 3,
  seed: 440,
  ages: [
    { label: "20s", min: 21, max: 29 },
    { label: "30–40s", min: 30, max: 49 },
    { label: "50+", min: 50, max: 68 },
  ],
  factors: [
    { name: "AI familiarity", promptLabel: "Familiarity with AI tools", enabled: true, levels: [
      { label: "High", text: "High — uses AI tools such as ChatGPT several times a week" },
      { label: "Low", text: "Low — has rarely or never used AI tools" },
    ]},
    { name: "Online shopping", promptLabel: "Online shopping", enabled: true, levels: [
      { label: "Often", text: "Shops online several times a week" },
      { label: "Rarely", text: "Shops online a few times a year" },
    ]},
  ],
  traits: [
    { name: "Health focus", promptLabel: "Eating habits", enabled: true, levels: [
      { label: "Health-conscious", text: "Watches sugar and reads nutrition labels" },
      { label: "Cutting down", text: "Trying to cut back on sugar but still enjoys treats" },
      { label: "Doesn't care", text: "Eats and drinks whatever they like" },
      { label: "Soda lover", text: "Drinks soda almost every day" },
    ]},
    { name: "Brand habits", promptLabel: "Trying new brands", enabled: true, levels: [
      { label: "Loyal", text: "Sticks to brands they already know" },
      { label: "Explorer", text: "Likes trying new brands and products" },
      { label: "Review reader", text: "Checks reviews before buying anything new" },
      { label: "Price first", text: "Buys whatever is cheapest or on sale" },
    ]},
    { name: "Temperament", promptLabel: "Personality", enabled: true, levels: [
      { label: "Enthusiastic", text: "Gets excited easily and reacts strongly" },
      { label: "Analytical", text: "Careful and detail-focused" },
      { label: "Easygoing", text: "Relaxed and easy to please" },
      { label: "Cynical", text: "Hard to impress and quick to criticize" },
    ]},
  ],
  format: "image",         // the persona sees an uploaded picture ("text" is kept only to reopen old pilot runs)
  image: null,             // { name, plain, labeled } as JPEG data URLs, made in the browser
  imageLabel: "AI-generated",
  ad: "",
  disclosure: "This ad was created using AI.",
  template: DEFAULT_TEMPLATE,
};

const CONDITIONS = ["none", "disclosed"];
const MEASURES = [
  ["trust", "Trust in the ad"],
  ["purchase_intent", "Purchase intent"],
  ["authenticity", "Perceived authenticity"],
];
const STORE_RUN = "persona-panel-run";
const STORE_CFG = "persona-panel-settings";
const STORE_KEY = "persona-panel-key";

/* ===================== 2. Small helpers ===================== */

const $ = (id) => document.getElementById(id);
const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get(k, area = localStorage) { try { return JSON.parse(area.getItem(k)); } catch { return null; } },
  set(k, v, area = localStorage) { try { area.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k, area = localStorage) { try { area.removeItem(k); } catch {} },
};

// Seeded random number generator (mulberry32) so a seed always gives the same panel.
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ===================== 3. Settings form <-> config ===================== */

function renderSettings(cfg) {
  $("model").value = cfg.model;
  $("temperature").value = cfg.temperature;
  $("perCell").value = cfg.perCell;
  $("concurrency").value = cfg.concurrency;
  $("seed").value = cfg.seed;
  $("ages").value = cfg.ages.map((a) => `${a.label} | ${a.min} | ${a.max}`).join("\n");
  $("ad").value = cfg.format === "image" ? cfg.ad : "";
  adImage = cfg.image ? { ...cfg.image } : null;
  $("imageLabel").value = cfg.imageLabel || DEFAULTS.imageLabel;
  showImagePreviews();
  $("template").value = cfg.template;
  $("factors").innerHTML = "";
  cfg.factors.forEach((f) => addFactorCard(f));
  $("traits").innerHTML = "";
  (cfg.traits || []).forEach((t) => addFactorCard(t, "traits"));
  updatePlan();
}

// Used for both design factors and random background traits; they share one card layout.
function addFactorCard(f, box = "factors") {
  const el = document.createElement("div");
  el.className = "factor" + (f.enabled ? "" : " off");
  el.innerHTML = `
    <div class="top">
      <input type="checkbox" class="f-on" aria-label="Include this ${box === "traits" ? "trait" : "factor"}" ${f.enabled ? "checked" : ""}>
      <input type="text" class="f-name" aria-label="Name" value="${esc(f.name)}" placeholder="${box === "traits" ? "Trait" : "Factor"} name">
      <button type="button" class="f-del danger" aria-label="Remove">Remove</button>
    </div>
    <label>Line label in the prompt<input type="text" class="f-plabel" value="${esc(f.promptLabel)}"></label>
    <label>${box === "traits" ? "Options" : "Levels"}<textarea class="f-levels" rows="${Math.max(3, f.levels.length + 1)}" spellcheck="false">${esc(f.levels.map((l) => `${l.label} | ${l.text}`).join("\n"))}</textarea></label>`;
  el.querySelector(".f-on").addEventListener("change", (e) => { el.classList.toggle("off", !e.target.checked); updatePlan(); });
  el.querySelector(".f-del").addEventListener("click", () => { el.remove(); updatePlan(); });
  el.addEventListener("input", updatePlan);
  $(box).appendChild(el);
}

// Read the form. Returns { cfg } or { error } with a message that says what to fix.
function readSettings() {
  const num = (id, min, max, int = true) => {
    const v = Number($(id).value);
    if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) throw new Error(`${$(id).previousElementSibling?.textContent || id} must be ${int ? "a whole number" : "a number"} from ${min} to ${max}.`);
    return v;
  };
  try {
    const ages = $("ages").value.split("\n").map((l) => l.trim()).filter(Boolean).map((line, i) => {
      const [label, min, max] = line.split("|").map((s) => s.trim());
      const a = { label, min: Number(min), max: Number(max) };
      if (!label || !Number.isInteger(a.min) || !Number.isInteger(a.max) || a.min > a.max || a.min < 13 || a.max > 100)
        throw new Error(`Age group line ${i + 1} should look like "20s | 21 | 29" with ages from 13 to 100.`);
      return a;
    });
    if (!ages.length) throw new Error("Add at least one age group.");
    const readCards = (box, kind) => [...$(box).querySelectorAll(".factor")].map((el, i) => {
      const name = el.querySelector(".f-name").value.trim();
      const levels = el.querySelector(".f-levels").value.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
        const at = line.indexOf("|");
        return at < 0 ? { label: line, text: line } : { label: line.slice(0, at).trim(), text: line.slice(at + 1).trim() };
      });
      const enabled = el.querySelector(".f-on").checked;
      if (enabled && !name) throw new Error(`${kind} ${i + 1} needs a name.`);
      if (enabled && levels.length < 2) throw new Error(`${kind} "${name}" needs at least two ${kind === "Trait" ? "options" : "levels"}.`);
      return { name, promptLabel: el.querySelector(".f-plabel").value.trim() || name, enabled, levels };
    });
    const factors = readCards("factors", "Factor"), traits = readCards("traits", "Trait");
    const names = [...factors, ...traits].filter((f) => f.enabled).map((f) => f.name);
    if (new Set(names).size !== names.length) throw new Error("Two factors or traits have the same name. Give each a different name.");
    const template = $("template").value;
    if (!template.includes("{profile}") || !template.includes("{ad}")) throw new Error("The prompt template must contain both {profile} and {ad}.");
    const format = "image";
    if (!adImage) throw new Error("Upload the ad image in Stimulus.");
    if (!$("imageLabel").value.trim()) throw new Error("Add the label drawn on the image.");
    if (!$("model").value.trim()) throw new Error("Enter a model name.");
    const cfg = {
      model: $("model").value.trim(),
      temperature: num("temperature", 0, 1, false),
      maxTokens: 1000,
      perCell: num("perCell", 1, 100),
      concurrency: num("concurrency", 1, 8),
      seed: num("seed", -2147483648, 2147483647),
      ages, factors, traits,
      format,
      image: format === "image" ? adImage : null,
      imageLabel: $("imageLabel").value.trim(),
      ad: $("ad").value.trim(),
      template,
    };
    return { cfg };
  } catch (e) {
    return { error: e.message };
  }
}

function cellCount(cfg) {
  return cfg.ages.length * cfg.factors.filter((f) => f.enabled).reduce((n, f) => n * f.levels.length, 1) * CONDITIONS.length;
}

function updatePlan() {
  const { cfg, error } = readSettings();
  $("configError").textContent = error || "";
  if (!cfg) { $("planText").innerHTML = ""; return; }
  store.set(STORE_CFG, cfg);
  const on = cfg.factors.filter((f) => f.enabled);
  const types = cellCount(cfg) / 2;
  const parts = [`${cfg.ages.length} age groups`, ...on.map((f) => `${f.levels.length} ${f.name.toLowerCase()} levels`)];
  const nt = (cfg.traits || []).filter((t) => t.enabled).length;
  $("planText").innerHTML = `<strong>${cellCount(cfg) * cfg.perCell} personas</strong> = ${parts.join(" × ")} (${types} types) × 2 conditions × ${cfg.perCell} per cell${nt ? ` · each with ${nt} random background trait${nt > 1 ? "s" : ""}` : ""}`;
}

/* ===================== 4. Panel and prompts ===================== */

function buildPanel(cfg) {
  const r = rng(cfg.seed);
  const factors = cfg.factors.filter((f) => f.enabled);
  // Every combination of factor levels.
  let combos = [[]];
  for (const f of factors) combos = combos.flatMap((c) => f.levels.map((l) => [...c, [f, l]]));
  const list = [];
  const traits = (cfg.traits || []).filter((t) => t.enabled);
  for (const a of cfg.ages) for (const combo of combos) for (const condition of CONDITIONS) for (let i = 0; i < cfg.perCell; i++) {
    const age = a.min + Math.floor(r() * (a.max - a.min + 1));
    const picks = traits.map((t) => [t, t.levels[Math.floor(r() * t.levels.length)]]);
    list.push({
      ageGroup: a.label,
      age,
      levels: Object.fromEntries(combo.map(([f, l]) => [f.name, l.label])),
      traits: Object.fromEntries(picks.map(([t, l]) => [t.name, l.label])),
      lines: [...combo, ...picks].map(([f, l]) => `- ${f.promptLabel}: ${l.text}`),
      condition,
    });
  }
  // Shuffle so any batch mixes conditions and groups.
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  const width = String(list.length).length;
  return list.map((p, i) => ({ ...p, id: "p" + String(i + 1).padStart(Math.max(3, width), "0") }));
}

function buildPrompt(p, cfg) {
  const profile = [`- Age: ${p.age}`, ...p.lines].join("\n");
  let ad;
  if (cfg.format === "image") ad = "[The ad image shown above]" + (cfg.ad ? `\nCaption under the image: ${cfg.ad}` : "");
  else ad = p.condition === "disclosed" ? `${cfg.ad}\n${cfg.disclosure}` : cfg.ad;
  return cfg.template.split("{profile}").join(profile).split("{ad}").join(ad);
}

// The picture this persona sees: the labelled version in the disclosed condition.
function imageFor(p, cfg) {
  if (cfg.format !== "image" || !cfg.image) return null;
  return p.condition === "disclosed" ? cfg.image.labeled : cfg.image.plain;
}

function buildRequest(p, cfg) {
  const prompt = buildPrompt(p, cfg), img = imageFor(p, cfg);
  // With an image ad, the image goes first and the text prompt follows it.
  const content = img
    ? [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.split(",")[1] } }, { type: "text", text: prompt }]
    : prompt;
  return { model: cfg.model, max_tokens: cfg.maxTokens, temperature: cfg.temperature, messages: [{ role: "user", content }] };
}

// Copy of a request for the log and the screen: image bytes are replaced by a short note,
// so 240 saved rows stay small. The full image is kept once in run.cfg.image.
function loggable(req, p) {
  const c = req.messages[0].content;
  if (typeof c === "string") return req;
  const which = p.condition === "disclosed" ? "with AI label" : "no label";
  return { ...req, messages: [{ role: "user", content: c.map((b) => b.type === "image" && !b.source.data.startsWith("<")
    ? { type: "image", source: { type: "base64", media_type: b.source.media_type, data: `<${run?.cfg.image?.name || "ad image"}, ${which}, ${Math.round(b.source.data.length * 0.75 / 1024)} KB omitted>` } }
    : b) }] };
}
function promptText(req) {
  const c = req?.messages?.[0]?.content;
  return typeof c === "string" ? c : (c || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// Pull the first {...} block out of the answer and check the three 1-7 scores.
function parseAnswer(raw) {
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(raw.slice(a, b + 1));
    const score = (k) => { const n = Number(o[k]); return Number.isInteger(n) && n >= 1 && n <= 7 ? n : null; };
    const out = { trust: score("trust"), purchase_intent: score("purchase_intent"), authenticity: score("authenticity"), reason: String(o.reason ?? "").slice(0, 500) };
    return out.trust && out.purchase_intent && out.authenticity ? out : null;
  } catch { return null; }
}

/* ===================== 4b. Image ads ===================== */

let adImage = null;   // { name, plain, labeled } for the image currently in the form

function showImagePreviews() {
  $("prevNone").src = adImage?.plain || "";
  $("prevDisc").src = adImage?.labeled || "";
  $("imageName").textContent = adImage ? adImage.name : "No image yet";
}
function loadImg(src) {
  return new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => bad(new Error("That file could not be read as an image.")); im.src = src; });
}
// Scale to at most 1024 px on the long side and re-encode as JPEG, which keeps each call near 1,400 image tokens.
async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const im = await loadImg(url);
    const k = Math.min(1, 1024 / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.88);
  } finally { URL.revokeObjectURL(url); }
}
// Draw a platform-style label (dark pill, white text) in the top-left corner.
async function labelImage(plain, text) {
  const im = await loadImg(plain);
  const c = document.createElement("canvas"); c.width = im.width; c.height = im.height;
  const g = c.getContext("2d"); g.drawImage(im, 0, 0);
  const W = c.width, m = Math.round(W * 0.03);
  let size = Math.max(14, Math.round(W * 0.05));
  const font = (s) => `600 ${s}px "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif`;
  g.font = font(size);
  while (g.measureText(text).width > W * 0.8 && size > 10) { size--; g.font = font(size); }
  const padX = Math.round(size * 0.6), h = Math.round(size * 1.7), w = Math.round(g.measureText(text).width + padX * 2);
  g.fillStyle = "rgba(15,15,18,0.78)";
  g.beginPath(); if (g.roundRect) g.roundRect(m, m, w, h, h / 2); else g.rect(m, m, w, h); g.fill();
  g.fillStyle = "#fff"; g.textBaseline = "middle"; g.fillText(text, m + padX, m + h / 2 + 1);
  return c.toDataURL("image/jpeg", 0.88);
}
async function relabel() {
  if (!adImage) return;
  adImage = { ...adImage, labeled: await labelImage(adImage.plain, $("imageLabel").value.trim() || " ") };
  showImagePreviews(); updatePlan();
}

/* ===================== 5. Claude API ===================== */

function apiKey() { return $("apiKey").value.trim(); }

async function callClaude(body, signal) {
  // Retries only on rate limits and temporary server errors, with growing waits.
  const waits = [2000, 6000, 15000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey(),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (res.ok) {
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      return { text, model: data.model, usage: data.usage, stop: data.stop_reason };
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < waits.length) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : waits[attempt]);
      continue;
    }
    const err = new Error(data?.error?.message || res.statusText || "Request failed");
    err.status = res.status;
    throw err;
  }
}

function explainError(e) {
  if (e.name === "AbortError") return null;
  if (e.status === 401) return "The API key was rejected. Check that it is copied in full and still active.";
  if (e.status === 403) return "This key is not allowed to use that model. Pick another model or check the key's workspace.";
  if (e.status === 404 || (e.status === 400 && /model/i.test(e.message))) return `The model name was not found: ${e.message}`;
  if (e.status === 400 && /credit|billing|balance/i.test(e.message)) return "The account has no API credit left. Add credit in the Claude Console, then run again.";
  if (e.status === 429) return "Rate limit reached even after waiting. Lower 'Parallel calls' and run again.";
  if (e.status >= 500) return "Anthropic's servers are busy. Wait a minute, then run again.";
  if (e instanceof TypeError) return "Could not reach api.anthropic.com. Check the internet connection, or serve this folder over http instead of opening the file directly.";
  return `The request failed: ${e.message}`;
}

/* ===================== 6. Run state ===================== */

let run = null;          // { cfg, personas, rows: {id: record}, createdAt }
let running = false;
let controller = null;
let selected = null;
let inFlight = 0;

function rows() { return run ? Object.values(run.rows) : []; }
// Personas with no usable answer yet. A cut-off or malformed answer is retried on the next run.
function pending() { return run ? run.personas.filter((p) => run.rows[p.id]?.status !== "ok") : []; }
function saveRun() { if (run && !store.set(STORE_RUN, run)) setStatus("This run is too large to autosave in the browser. Use 'Save run (JSON)' to keep it.", true); }

function setStatus(text, isError = false) { const s = $("status"); s.textContent = text; s.classList.toggle("err", isError); }

function createRun(cfg) {
  run = { cfg: clone(cfg), personas: buildPanel(cfg), rows: {}, createdAt: new Date().toISOString() };
  selected = null;
  saveRun();
  clearSteps();
  renderAll();
  setStatus(`Panel ready: ${run.personas.length} personas. Start with one to see each step.`);
}

async function runOne(p, signal) {
  const cfg = run.cfg;
  const request = buildRequest(p, cfg);
  const live = inFlight <= 1;              // only animate the steps when one call runs at a time
  if (live) { selected = p.id; showPersona(p); showRequest(request, p); $("s3b").innerHTML = '<p class="empty">Waiting for Claude…</p>'; showRecord(null); activate(3); }
  const res = await callClaude(request, signal);
  const parsed = parseAnswer(res.text);
  const rec = {
    id: p.id, age: p.age, age_group: p.ageGroup, ...prefixLevels(p.levels), ...prefixLevels(p.traits || {}, "t:"), condition: p.condition,
    status: parsed ? "ok" : "unparsed",
    trust: parsed?.trust ?? null, purchase_intent: parsed?.purchase_intent ?? null, authenticity: parsed?.authenticity ?? null,
    reason: parsed?.reason ?? "",
    model: res.model, input_tokens: res.usage?.input_tokens ?? null, output_tokens: res.usage?.output_tokens ?? null,
    stop_reason: res.stop, timestamp: new Date().toISOString(),
    request: loggable(request, p), raw: res.text,
  };
  run.rows[p.id] = rec;
  if (live || selected === p.id) inspect(p.id, false);
  return rec;
}

function prefixLevels(levels, pre = "f:") { return Object.fromEntries(Object.entries(levels).map(([k, v]) => [pre + k, v])); }

async function runBatch(limit) {
  if (running || !run) return;
  if (!apiKey()) { setStatus("Enter your API key in Setup first.", true); $("apiKey").focus(); return; }
  const queue = pending().slice(0, limit);
  if (!queue.length) { setStatus("Every persona in this panel has responded."); return; }
  running = true; controller = new AbortController(); syncButtons();
  let done = 0, failed = null;
  const total = queue.length;
  const workers = Array.from({ length: Math.min(run.cfg.concurrency, total) }, async () => {
    while (queue.length && !failed && !controller.signal.aborted) {
      const p = queue.shift();
      inFlight++;
      setStatus(`Running… ${done} of ${total} done${inFlight > 1 ? `, ${inFlight} calls in progress` : ""}`);
      try { await runOne(p, controller.signal); done++; saveRun(); renderAll(); }
      catch (e) { const msg = explainError(e); if (msg) { failed = msg; controller.abort(); } }
      finally { inFlight--; }
    }
  });
  await Promise.all(workers);
  running = false; syncButtons(); renderAll();
  if (failed) setStatus(`${failed} (${done} recorded before it stopped.)`, true);
  else if (controller.signal.aborted) setStatus(`Stopped. ${done} recorded.`);
  else setStatus(pending().length ? `Done: ${done} persona${done === 1 ? "" : "s"} recorded.` : `All ${run.personas.length} personas have responded.`);
}

/* ===================== 7. Inspector (the four steps) ===================== */

function chip(c) { return c === "disclosed" ? '<span class="chip disclosed">AI disclosed</span>' : '<span class="chip none">No disclosure</span>'; }
function activate(n) { for (let i = 1; i <= 4; i++) $("s" + i).classList.toggle("active", i === n); }
function clearSteps() {
  $("s1b").innerHTML = '<p class="empty">The next persona appears here.</p>';
  $("s2b").innerHTML = '<p class="empty">The exact request body sent to Claude.</p>';
  $("s3b").innerHTML = '<p class="empty">Claude\'s unedited answer.</p>';
  $("s4b").innerHTML = '<p class="empty">The parsed scores saved to the dataset.</p>';
  activate(0);
}
function showPersona(p) {
  const lv = Object.entries({ ...p.levels, ...(p.traits || {}) }).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  $("s1b").innerHTML = `<dl class="kv"><dt>ID</dt><dd>${p.id}</dd><dt>Age</dt><dd>${p.age} (${esc(p.ageGroup)})</dd>${lv}<dt>Condition</dt><dd>${chip(p.condition)}</dd></dl>`;
}
function showRequest(req, p) {
  const img = imageFor(p, run.cfg);
  const pic = img ? `<img class="reqimg" src="${img}" alt="The image this persona was shown">` : "";
  $("s2b").innerHTML = `<p class="hint">POST https://api.anthropic.com/v1/messages</p>${pic}<pre>${esc(JSON.stringify(loggable(req, p), null, 2))}</pre>`;
}
function showRecord(rec) {
  if (!rec) { $("s4b").innerHTML = '<p class="empty">Waiting for the response.</p>'; return; }
  const meta = `<p class="hint">${esc(rec.model || "")} · ${rec.input_tokens ?? "?"} in / ${rec.output_tokens ?? "?"} out tokens</p>`;
  if (rec.status !== "ok") {
    const why = rec.stop_reason === "max_tokens" ? "The answer was cut off at the length limit before the scores were complete." : "The answer had no valid 1–7 scores.";
    $("s4b").innerHTML = `<p><span class="chip bad">Not usable</span></p><p class="hint">${why} It is left out of the results and will be asked again on the next run.</p>${meta}`; return;
  }
  $("s4b").innerHTML = `<div class="scores"><div class="score"><span>Trust</span><strong>${rec.trust}</strong></div><div class="score"><span>Intent</span><strong>${rec.purchase_intent}</strong></div><div class="score"><span>Authentic</span><strong>${rec.authenticity}</strong></div></div><p class="reason">“${esc(rec.reason)}”</p>${meta}`;
}
function inspect(id, scroll = true) {
  const p = run?.personas.find((x) => x.id === id); if (!p) return;
  const rec = run.rows[id];
  selected = id;
  showPersona(p);
  showRequest(rec?.request || buildRequest(p, run.cfg), p);
  if (rec) $("s3b").innerHTML = `<pre>${esc(rec.raw)}</pre>`; else $("s3b").innerHTML = '<p class="empty">Not run yet.</p>';
  showRecord(rec || null);
  activate(rec ? 4 : 0);
  renderLog();
  if (scroll) $("run").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

/* ===================== 8. Log, progress, buttons ===================== */

function factorNames() { return run ? run.cfg.factors.filter((f) => f.enabled).map((f) => f.name) : []; }

function renderLog() {
  const fn = factorNames();
  $("logHead").innerHTML = `<tr><th>ID</th><th class="num">Age</th>${fn.map((n) => `<th>${esc(n)}</th>`).join("")}<th>Condition</th><th class="num">Trust</th><th class="num">Intent</th><th class="num">Auth.</th><th>Reason</th></tr>`;
  const list = rows().sort((a, b) => (a.id < b.id ? -1 : 1));
  if (!list.length) { $("logBody").innerHTML = `<tr><td colspan="${8 + fn.length}" class="empty">No responses yet. Run a persona and its row appears here.</td></tr>`; return; }
  $("logBody").innerHTML = list.map((x) => `<tr data-id="${x.id}" class="${x.id === selected ? "sel" : ""}"><td>${x.id}</td><td class="num">${x.age}</td>${fn.map((n) => `<td>${esc(x["f:" + n])}</td>`).join("")}<td>${chip(x.condition)}</td>${
    x.status === "ok" ? `<td class="num">${x.trust}</td><td class="num">${x.purchase_intent}</td><td class="num">${x.authenticity}</td><td class="reason">${esc(x.reason)}</td>` : '<td colspan="4"><span class="chip bad">Not usable</span></td>'}</tr>`).join("");
}

function renderProgress() {
  const total = run?.personas.length || 0, list = rows();
  const d = list.filter((x) => x.condition === "disclosed").length, n = list.length - d;
  $("barN").style.width = total ? (n / total) * 100 + "%" : "0";
  $("barD").style.width = total ? (d / total) * 100 + "%" : "0";
  const tokIn = list.reduce((s, x) => s + (x.input_tokens || 0), 0), tokOut = list.reduce((s, x) => s + (x.output_tokens || 0), 0);
  $("ptext").textContent = run ? `${list.length} / ${total} responses · ${n} no disclosure · ${d} AI disclosed · ${tokIn.toLocaleString()} in / ${tokOut.toLocaleString()} out tokens` : "Create a panel in Setup first.";
}

function syncButtons() {
  const left = pending().length > 0;
  for (const id of ["run1", "run10", "runAll"]) $(id).disabled = running || !run || !left;
  $("stop").disabled = !running;
  $("createRun").disabled = running;
  $("exportCsv").disabled = !rows().length;
  $("exportJson").disabled = !run;
}

/* ===================== 9. Statistics ===================== */

function lgamma(z) {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1; let x = c[0]; for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function betacf(a, b, x) {
  const F = 1e-300; let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < F) d = F; d = 1 / d; let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m; let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < F) d = F; c = 1 + aa / c; if (Math.abs(c) < F) c = F; d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < F) d = F; c = 1 + aa / c; if (Math.abs(c) < F) c = F; d = 1 / d;
    const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}
// Regularized incomplete beta, used for the two-sided t-test p-value.
function ibeta(x, a, b) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
function summary(v) {
  const n = v.length; if (!n) return { n, mean: NaN, sd: NaN };
  const m = v.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)) : 0;
  return { n, mean: m, sd };
}
// Welch's t-test for disclosed (a) minus not disclosed (b), plus Cohen's d.
function welch(a, b) {
  const A = summary(a), B = summary(b); if (A.n < 2 || B.n < 2) return null;
  const va = A.sd ** 2 / A.n, vb = B.sd ** 2 / B.n, se = Math.sqrt(va + vb), diff = A.mean - B.mean;
  if (se === 0) return { diff, se: 0, p: diff === 0 ? 1 : 0, d: 0, A, B };
  const t = diff / se, df = (va + vb) ** 2 / (va * va / (A.n - 1) + vb * vb / (B.n - 1));
  const sp = Math.sqrt(((A.n - 1) * A.sd ** 2 + (B.n - 1) * B.sd ** 2) / (A.n + B.n - 2));
  return { diff, se, t, df, p: ibeta(df / (df + t * t), df / 2, 0.5), d: sp ? diff / sp : 0, A, B };
}
const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");
const fmtP = (p) => (p < 0.001 ? "p < .001" : "p = " + p.toFixed(3).replace(/^0/, ""));
const signed = (x) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(2);

/* ===================== 10. Results and charts ===================== */

function dotChart(ok) {
  const W = 640, L = 170, R = 24, rowH = 58, top = 28, H = top + rowH * MEASURES.length + 28;
  const x = (v) => L + ((v - 1) / 6) * (W - L - R);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Mean ratings by condition with 95% confidence intervals">`;
  for (let v = 1; v <= 7; v++) s += `<line class="grid" x1="${x(v)}" x2="${x(v)}" y1="${top - 8}" y2="${H - 26}"/><text class="muted" x="${x(v)}" y="${H - 8}" font-size="12" text-anchor="middle">${v}</text>`;
  MEASURES.forEach(([k, label], i) => {
    const y = top + i * rowH + rowH / 2 - 8;
    s += `<text x="0" y="${y + 4}" font-size="14">${label}</text>`;
    [["none", "--none", -9], ["disclosed", "--disc", 9]].forEach(([c, col, dy]) => {
      const S = summary(ok.filter((o) => o.condition === c).map((o) => o[k])); if (S.n < 2) return;
      const ci = (1.96 * S.sd) / Math.sqrt(S.n), cy = y + dy, hi = Math.min(7, S.mean + ci);
      s += `<line x1="${x(Math.max(1, S.mean - ci))}" x2="${x(hi)}" y1="${cy}" y2="${cy}" stroke="var(${col})" stroke-width="2"/><circle cx="${x(S.mean)}" cy="${cy}" r="6" fill="var(${col})" stroke="var(--surface)" stroke-width="2"/><text class="muted" x="${Math.min(W - 30, x(hi) + 8)}" y="${cy + 4}" font-size="12">${fmt(S.mean)}</text>`;
    });
  });
  return s + "</svg>";
}

function diffChart(ok) {
  const groups = [["All respondents", () => true], ...run.cfg.ages.map((a) => [`Age ${a.label}`, (o) => o.age_group === a.label])];
  for (const f of run.cfg.factors.filter((f) => f.enabled)) for (const l of f.levels) groups.push([`${f.name}: ${l.label}`, (o) => o["f:" + f.name] === l.label]);
  const res = groups.map(([label, keep]) => {
    const sub = ok.filter(keep);
    return [label, welch(sub.filter((o) => o.condition === "disclosed").map((o) => o.trust), sub.filter((o) => o.condition === "none").map((o) => o.trust))];
  });
  let ext = 1; for (const [, w] of res) if (w) ext = Math.max(ext, Math.abs(w.diff) + 1.96 * w.se);
  ext = Math.ceil(ext * 2) / 2;
  const W = 640, L = 230, R = 60, rowH = 32, top = 18, H = top + rowH * res.length + 30;
  const x = (v) => L + ((v + ext) / (2 * ext)) * (W - L - R);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Change in trust when AI use is disclosed, by subgroup">`;
  const step = ext > 1.5 ? 1 : 0.5;
  for (let v = -Math.floor(ext / step) * step; v <= ext + 1e-9; v += step) s += `<line class="grid" x1="${x(v)}" x2="${x(v)}" y1="${top - 6}" y2="${H - 24}"/><text class="muted" x="${x(v)}" y="${H - 6}" font-size="12" text-anchor="middle">${v === 0 ? "0" : (v > 0 ? "+" : "−") + Math.abs(v)}</text>`;
  s += `<line class="zero" x1="${x(0)}" x2="${x(0)}" y1="${top - 6}" y2="${H - 24}"/>`;
  res.forEach(([label, w], i) => {
    const y = top + i * rowH + rowH / 2;
    s += `<text x="0" y="${y + 4}" font-size="14"${i === 0 ? ' font-weight="600"' : ""}>${esc(label.length > 30 ? label.slice(0, 29) + "…" : label)}</text>`;
    if (!w) { s += `<text class="muted" x="${x(0) + 8}" y="${y + 4}" font-size="12">not enough data</text>`; return; }
    const lo = Math.max(-ext, w.diff - 1.96 * w.se), hi = Math.min(ext, w.diff + 1.96 * w.se);
    s += `<line x1="${x(lo)}" x2="${x(hi)}" y1="${y}" y2="${y}" stroke="var(--ink)" stroke-width="2"/><circle cx="${x(w.diff)}" cy="${y}" r="${i === 0 ? 7 : 5.5}" fill="var(--ink)" stroke="var(--surface)" stroke-width="2"/><text class="muted" x="${W - R + 10}" y="${y + 4}" font-size="12">${signed(w.diff)}</text>`;
  });
  return s + "</svg>";
}

function renderResults() {
  const ok = rows().filter((x) => x.status === "ok");
  const nD = ok.filter((o) => o.condition === "disclosed").length, nN = ok.length - nD;
  if (nD < 4 || nN < 4) { $("resultsBody").innerHTML = `<p class="empty">Results appear once each condition has at least 4 usable responses (now: ${nN} no disclosure, ${nD} AI disclosed).</p>`; return; }
  const w = (k) => welch(ok.filter((o) => o.condition === "disclosed").map((o) => o[k]), ok.filter((o) => o.condition === "none").map((o) => o[k]));
  const stats = MEASURES.map(([k, label]) => [label, w(k)]);
  const unusable = rows().length - ok.length;
  $("resultsBody").innerHTML = `
  <div style="display:flex;flex-direction:column;gap:18px">
    <div class="headline">
      ${stats.map(([label, s]) => `<div class="stat"><span>Change in ${label.toLowerCase()} when disclosed</span><strong>${signed(s.diff)}</strong><span>${fmtP(s.p)} · d = ${fmt(s.d)}</span></div>`).join("")}
      <div class="stat"><span>Usable responses</span><strong>${ok.length}</strong><span>${nN} no disclosure · ${nD} disclosed${unusable ? ` · ${unusable} unusable` : ""}</span></div>
    </div>
    <div class="grid">
      <div class="card"><h3>Mean rating by condition (1–7, 95% CI)</h3>
        <div class="legend"><span><i style="background:var(--none)"></i>No disclosure</span><span><i style="background:var(--disc)"></i>AI disclosed</span></div>
        ${dotChart(ok)}</div>
      <div class="card"><h3>Change in trust when AI is disclosed, by group</h3>
        <p class="hint">Disclosed minus not disclosed, with 95% CI. Left of the dashed line means disclosure lowered trust.</p>
        ${diffChart(ok)}</div>
    </div>
    <p class="hint">Welch's t-test; d is Cohen's d. Stimulus: ${run.cfg.format === "image" ? "image ad" : "text ad"}. Model: ${esc(run.cfg.model)}, temperature ${run.cfg.temperature}. Subgroup intervals are wide because each subgroup is a fraction of the sample. All respondents are LLM-simulated.</p>
  </div>`;
}

function renderAll() { renderProgress(); renderLog(); renderResults(); syncButtons(); }

/* ===================== 11. Export and import ===================== */

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCsv() {
  const fcols = [...factorNames().map((n) => "f:" + n), ...(run.cfg.traits || []).filter((t) => t.enabled).map((t) => "t:" + t.name)];
  const cols = ["id", "age", "age_group", ...fcols, "condition", "status", "trust", "purchase_intent", "authenticity", "reason", "model", "input_tokens", "output_tokens", "timestamp", "prompt", "raw"];
  const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = rows().sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => cols.map((c) => q(c === "prompt" ? promptText(r.request) : r[c])).join(","));
  download("synthetic_consumer_panel.csv", "\uFEFF" + [cols.map((c) => c.replace(/^[ft]:/, "")).join(","), ...lines].join("\n"), "text/csv");
}

function exportJson() { download(`panel_run_${run.createdAt.slice(0, 10)}.json`, JSON.stringify(run, null, 2), "application/json"); }

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data?.cfg || !Array.isArray(data.personas) || typeof data.rows !== "object") throw new Error();
      run = data; selected = null; saveRun(); renderSettings(run.cfg); clearSteps(); renderAll();
      setStatus(`Loaded a run from ${run.createdAt.slice(0, 10)} with ${Object.keys(run.rows).length} responses.`);
    } catch { setStatus("That file is not a saved run from this program.", true); }
  };
  reader.readAsText(file);
}

/* ===================== 12. Wiring ===================== */

function init() {
  const savedCfg = store.get(STORE_CFG);
  run = store.get(STORE_RUN);
  renderSettings(run?.cfg || savedCfg || DEFAULTS);

  const remembered = store.get(STORE_KEY) || store.get(STORE_KEY, sessionStorage);
  if (remembered) $("apiKey").value = remembered;
  $("rememberKey").checked = !!store.get(STORE_KEY);
  const keepKey = () => {
    const k = apiKey();
    if ($("rememberKey").checked) { store.set(STORE_KEY, k); store.del(STORE_KEY, sessionStorage); }
    else { store.del(STORE_KEY); store.set(STORE_KEY, k, sessionStorage); }
  };
  $("apiKey").addEventListener("input", keepKey);
  $("rememberKey").addEventListener("change", keepKey);

  for (const id of ["model", "temperature", "perCell", "concurrency", "seed", "ages", "ad", "template"]) $(id).addEventListener("input", updatePlan);
  let labelTimer = null;
  $("imageLabel").addEventListener("input", () => { clearTimeout(labelTimer); labelTimer = setTimeout(relabel, 250); });
  $("imageFile").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    try {
      const plain = await prepareImage(f);
      adImage = { name: f.name, plain, labeled: plain };
      await relabel();
    } catch (err) { $("configError").textContent = err.message; }
  });
  $("addFactor").onclick = () => { addFactorCard({ name: "", promptLabel: "", enabled: true, levels: [] }); updatePlan(); };
  $("addTrait").onclick = () => { addFactorCard({ name: "", promptLabel: "", enabled: true, levels: [] }, "traits"); updatePlan(); };
  $("resetDefaults").onclick = () => {
    renderSettings({ ...DEFAULTS, image: adImage, ad: $("ad").value });   // keep the uploaded ad and caption
    relabel();
    $("configError").textContent = "";
    $("resetDefaults").textContent = "Defaults restored ✓";
    setTimeout(() => { $("resetDefaults").textContent = "Restore default settings"; }, 2000);
  };

  let armed = null;
  $("createRun").onclick = () => {
    const { cfg, error } = readSettings();
    if (error) { $("configError").textContent = error; return; }
    if (rows().length && !armed) {
      $("createRun").textContent = `Confirm: replace the current ${rows().length} responses`;
      armed = setTimeout(() => { armed = null; $("createRun").textContent = "Create panel from these settings"; }, 5000);
      return;
    }
    clearTimeout(armed); armed = null; $("createRun").textContent = "Create panel from these settings";
    createRun(cfg);
    $("run").scrollIntoView({ behavior: "smooth" });
  };

  $("testKey").onclick = async () => {
    if (!apiKey()) { $("keyStatus").textContent = "Enter a key first."; return; }
    $("keyStatus").textContent = "Testing…";
    try { const r = await callClaude({ model: $("model").value.trim(), max_tokens: 5, messages: [{ role: "user", content: "Reply with OK." }] }); $("keyStatus").textContent = `Key works (${r.model}).`; }
    catch (e) { $("keyStatus").textContent = explainError(e) || "Cancelled."; }
  };

  $("run1").onclick = () => runBatch(1);
  $("run10").onclick = () => runBatch(10);
  $("runAll").onclick = () => runBatch(Infinity);
  $("stop").onclick = () => controller?.abort();
  $("logBody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) inspect(tr.dataset.id); });
  $("exportCsv").onclick = exportCsv;
  $("exportJson").onclick = exportJson;
  $("importJson").addEventListener("change", (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ""; });

  renderAll();
  setStatus(run ? `Restored the last panel: ${rows().length} of ${run.personas.length} responses.` : "Create a panel in Setup, then run one persona to see each step.");
}

init();
