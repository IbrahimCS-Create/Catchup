// Catchup server. Zero dependencies: only Node's built-in modules (Node 18+).
// Job: serve the page, and turn each chat message into structured plan data using an AI model.
// Providers: Groq (preferred if GROQ_API_KEY is set) and Google Gemini (if GEMINI_API_KEY is set).
// API keys live ONLY here (read from .env), never in the browser or the repo.

const http = require("http");
const fs = require("fs");
const path = require("path");

// ---- tiny .env loader (so we don't need the dotenv package) ----
try {
  const envText = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch (_) {
  /* no .env file: fine, we fall back to the cached demo outputs */
}

const PORT = process.env.PORT || 3000;
const real = (v) => (v && v !== "paste_your_key_here" ? v : "");
const GROQ_KEY = real(process.env.GROQ_API_KEY);
const GEMINI_KEY = real(process.env.GEMINI_API_KEY);

const CACHE = JSON.parse(fs.readFileSync(path.join(__dirname, "demo-cache.json"), "utf8"));

const SYSTEM_PROMPT = `You are the invisible assistant inside a friend group chat. Nobody talks to you.
You read each new message and quietly extract anything actionable. Be conservative: banter,
reactions and small talk produce NOTHING.

You receive: today's date with a calendar of the upcoming days, the events and tasks ALREADY on the board,
the currently OPEN decisions, and the new message.
Return ONLY a JSON object with exactly this shape:
{
  "events": [{"title": string, "date": "YYYY-MM-DD", "weekday": string, "time": "HH:MM" or "", "place": string}],
  "tasks": [{"what": string, "who": string}],
  "decisions_opened": [{"question": string}],
  "decisions_resolved": [{"match": string, "answer": string}]
}
Rules:
- events: only when a plan is fixed or newly proposed with a time. Do NOT repeat an event already on the board.
  "title" must describe the activity ("Dinner at Nando's", "Meet before dinner"), never just a time or day.
  For days, ONLY use dates from the calendar you are given ("Saturday" = the Saturday in that calendar).
  If today is that same weekday, a bare weekday name means NEXT week's, unless the message says today or tonight.
  If the message gives a time but no day, use the date of the most recent event on the board.
  24-hour time.
- tasks: someone commits ("I'll book it") or a job is clearly needed ("can someone get a cake?").
  If the task is already on the board, reuse its EXACT existing "what" text; do not reword it.
  When a volunteer takes an Unassigned task, return that same exact "what" with the volunteer as "who".
  "who" is the speaker's name if they volunteer, otherwise "Unassigned".
  Write new tasks as short action phrases with the key detail ("Book the table at Nando's").
- decisions_opened: the group asks a genuine either/or or open question that is not yet answered.
  Write "question" as a short neutral question of at most 10 words, not the raw message.
  Do not reopen a question that is already open.
  A proposal phrased as a question ("dinner saturday at 7?") is NOT a decision: if you add it as an event,
  do not also open a decision about it. Only open a decision when there are real competing options
  ("friday or saturday?", "nandos or wagamama?") or nobody has proposed an answer yet ("where should we go?").
- decisions_resolved: ONLY when a message states a firm final choice ("Saturday 7pm it is then", "let's do X").
  Leaning or agreeing ("Saturday works better", "same") does NOT resolve anything.
  "match" must be the exact question text of that open decision from the list, "answer" a short summary.
- If nothing is actionable return all four arrays empty.
- Output JSON only. No markdown, no commentary.`;

function emptyResult() {
  return { events: [], tasks: [], decisions_opened: [], decisions_resolved: [] };
}

function normalise(obj) {
  const out = emptyResult();
  if (!obj || typeof obj !== "object") return out;
  for (const k of Object.keys(out)) out[k] = Array.isArray(obj[k]) ? obj[k] : [];
  return out;
}

function parseJsonLoose(text) {
  return JSON.parse(String(text).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "").trim());
}

function httpError(label, res, body) {
  const err = new Error(`${label} HTTP ${res.status}: ${String(body).replace(/\s+/g, " ").slice(0, 220)}`);
  err.status = res.status;
  return err;
}

// ---- providers ----
async function callGroq(model, userText) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
    }),
  });
  const body = await res.text();
  if (!res.ok) throw httpError(`groq/${model}`, res, body);
  return parseJsonLoose(JSON.parse(body)?.choices?.[0]?.message?.content || "");
}

async function callGemini(model, userText) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
    }),
  });
  const body = await res.text();
  if (!res.ok) throw httpError(`gemini/${model}`, res, body);
  const text = JSON.parse(body)?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  return parseJsonLoose(text);
}

// Model names change over time, so each provider has a list tried in order.
const PROVIDERS = [
  GROQ_KEY && {
    name: "groq",
    call: callGroq,
    models: [process.env.GROQ_MODEL, "llama-3.3-70b-versatile", "openai/gpt-oss-20b", "llama-3.1-8b-instant"].filter(Boolean),
  },
  GEMINI_KEY && {
    name: "gemini",
    call: callGemini,
    models: [process.env.GEMINI_MODEL, "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.0-flash"].filter(Boolean),
  },
].filter(Boolean);

let working = null; // { provider, model } of the last call that succeeded
const logged = new Set();
function logOnce(msg) {
  if (logged.has(msg)) return;
  logged.add(msg);
  console.error("[ai]", msg);
}

// Small AI models are bad at weekday arithmetic, so WE compute the calendar and hand it over.
function dayLabel(todayIso, offset) {
  const d = new Date(todayIso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + offset);
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  return `${weekday} ${d.toISOString().slice(0, 10)}`;
}
function calendar(todayIso) {
  return Array.from({ length: 14 }, (_, i) => `- ${dayLabel(todayIso, i)}${i === 0 ? " (today)" : ""}`).join("\n");
}

async function extract({ message, from, today, openDecisions, events, tasks }) {
  const userText =
    `Today is ${dayLabel(today, 0)} (today).\n` +
    `Upcoming days:\n${calendar(today)}\n` +
    `Events already on the board: ${JSON.stringify(events || [])}\n` +
    `Tasks already on the board: ${JSON.stringify(tasks || [])}\n` +
    `Open decisions: ${JSON.stringify(openDecisions || [])}\n` +
    `New message from ${from}: ${message}`;

  if (PROVIDERS.length) {
    // Try the last working provider/model first, then everything else in order.
    const attempts = [];
    if (working) attempts.push({ p: PROVIDERS.find((x) => x.name === working.provider), model: working.model });
    for (const p of PROVIDERS) for (const model of p.models) attempts.push({ p, model });

    let lastErr;
    const skipProviders = new Set();
    for (const { p, model } of attempts) {
      if (!p || skipProviders.has(p.name)) continue;
      try {
        const result = normalise(await p.call(model, userText));
        working = { provider: p.name, model };
        return { result, source: `live:${p.name}/${model}` };
      } catch (e) {
        lastErr = e;
        logOnce(e.message);
        if (working && working.provider === p.name && working.model === model) working = null;
        // Wrong model name / bad request: try the next model. Anything else (bad key, rate limit): next provider.
        const modelProblem = [400, 404].includes(e.status) || e instanceof SyntaxError;
        if (!modelProblem) skipProviders.add(p.name);
      }
    }
    if (CACHE[message]) return { result: normalise(CACHE[message]), source: "cached-fallback", error: String(lastErr && lastErr.message) };
    return { result: emptyResult(), source: "error", error: String(lastErr && lastErr.message) };
  }

  if (CACHE[message]) return { result: normalise(CACHE[message]), source: "cached-no-key" };
  return { result: emptyResult(), source: "no-key" };
}

// ---------- board state: lives on the server so the web page AND Telegram share it ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
const similar = (a, b) => { a = norm(a); b = norm(b); return !!a && !!b && (a === b || a.includes(b) || b.includes(a)); };
const londonToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" }); // YYYY-MM-DD

let state;
function resetState() {
  state = { epoch: (state ? state.epoch : 0) + 1, messages: [], events: [], tasks: [], decisions: [], nextId: 1, nextMsgId: 1, lastSource: null };
}
resetState();

// Fold what the AI returned into the board. Returns short notes about what changed.
function merge(r) {
  const notes = [];
  for (const e of r.events || []) {
    if (!e || !e.title) continue;
    const dup = state.events.some(
      (x) => (e.date && x.date === e.date && (x.time || "") === (e.time || "")) || norm(x.title) === norm(e.title)
    );
    if (!dup) {
      state.events.push({ title: e.title, date: e.date || "", weekday: e.weekday || "", time: e.time || "", place: e.place || "" });
      notes.push("Added plan: " + e.title + (e.time ? " at " + e.time : ""));
    }
  }
  for (const t of r.tasks || []) {
    if (!t || !t.what) continue;
    const existing = state.tasks.find((x) => similar(x.what, t.what));
    if (existing) {
      if (t.who && t.who !== "Unassigned" && existing.who !== t.who) {
        existing.who = t.who;
        notes.push(`${t.who} took: ${existing.what}`);
      }
    } else {
      state.tasks.push({ what: t.what, who: t.who || "Unassigned" });
      notes.push((t.who && t.who !== "Unassigned" ? t.who + " took: " : "New task: ") + t.what);
    }
  }
  for (const d of r.decisions_opened || []) {
    if (!d || !d.question) continue;
    // Safety net: skip a "decision" that just restates a plan added from this same message.
    const words = (s) => norm(s).split(/\s+/).filter((w) => w.length > 2 && !["the", "and", "for"].includes(w));
    const restatesPlan = (r.events || []).some((e) => {
      if (!e || !e.title) return false;
      const tw = words(e.title), qw = new Set(words(d.question));
      return tw.length > 0 && tw.filter((w) => qw.has(w)).length / tw.length >= 0.6;
    });
    if (restatesPlan && !/\bor\b/i.test(d.question)) continue;
    if (!state.decisions.some((x) => x.status === "open" && similar(x.question, d.question))) {
      state.decisions.push({ id: state.nextId++, question: d.question, status: "open", answer: "" });
      notes.push("Open question flagged: " + d.question);
    }
  }
  for (const d of r.decisions_resolved || []) {
    if (!d) continue;
    const m = state.decisions.find((x) => x.status === "open" && similar(x.question, d.match));
    if (m) {
      m.status = "resolved";
      m.answer = d.answer || "";
      notes.push("Decision made: " + (d.answer || m.question));
    }
  }
  return notes;
}

// One message at a time, in order, so the board never gets two updates racing each other.
let queue = Promise.resolve();
function handleMessage({ from, text, via = "web", today, chatId }) {
  const epoch = state.epoch;
  const msg = { id: state.nextMsgId++, from, text, via, notes: [], status: "reading" };
  state.messages.push(msg);
  const job = queue.then(async () => {
    if (epoch !== state.epoch) return msg; // board was reset while waiting
    const out = await extract({
      message: text,
      from,
      today: today || londonToday(),
      openDecisions: state.decisions.filter((d) => d.status === "open").map((d) => ({ id: d.id, question: d.question })),
      events: state.events.map((e) => ({ title: e.title, date: e.date, time: e.time, place: e.place })),
      tasks: state.tasks.map((t) => ({ what: t.what, who: t.who })),
    });
    if (epoch !== state.epoch) return msg;
    state.lastSource = out.source;
    msg.notes = merge(out.result);
    msg.status = out.source === "error" ? "error" : "done";
    if (via === "telegram" && process.env.TELEGRAM_REPLY === "true" && msg.notes.length && chatId) {
      tgApi("sendMessage", { chat_id: chatId, text: msg.notes.map((n) => "✅ " + n).join("\n") }).catch(() => {});
    }
    return msg;
  });
  queue = job.catch(() => {});
  return job;
}

// ---------- calendar export (the "takes action" part) ----------
function icsEscape(x) {
  return String(x || "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
function buildIcs() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const f = (d) => d.toISOString().replace(/[-:]/g, "").slice(0, 15);
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Catchup//EN", "CALSCALE:GREGORIAN"];
  state.events.forEach((e, i) => {
    if (!e.date) return;
    lines.push("BEGIN:VEVENT", `UID:catchup-${Date.now()}-${i}@catchup.local`, `DTSTAMP:${stamp}`);
    if (/^\d{2}:\d{2}$/.test(e.time || "")) {
      const start = new Date(`${e.date}T${e.time}:00Z`);
      lines.push(`DTSTART:${f(start)}`, `DTEND:${f(new Date(start.getTime() + 2 * 3600 * 1000))}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${e.date.replace(/-/g, "")}`);
    }
    lines.push(`SUMMARY:${icsEscape(e.title)}`);
    if (e.place) lines.push(`LOCATION:${icsEscape(e.place)}`);
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

// ---------- Telegram: a bot that silently reads a group chat ----------
const TG_TOKEN = real(process.env.TELEGRAM_BOT_TOKEN);
const tg = { enabled: !!TG_TOKEN, connected: false, botName: "", error: "" };

async function tgApi(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params || {}),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${method}: ${j.description || res.status}`);
  return j.result;
}

async function telegramLoop() {
  try {
    const me = await tgApi("getMe");
    tg.connected = true;
    tg.botName = me.username;
    console.log(`Telegram bot connected as @${me.username}. Add it to a group and chat.`);
    await tgApi("deleteWebhook", { drop_pending_updates: true }).catch(() => {});
  } catch (e) {
    tg.error = e.message;
    console.error("[telegram] could not start:", e.message);
    return;
  }
  let offset = 0;
  for (;;) {
    try {
      const updates = await tgApi("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
      tg.error = "";
      for (const u of updates) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m || !m.text || m.text.startsWith("/") || (m.from && m.from.is_bot)) continue;
        const from = (m.from && (m.from.first_name || m.from.username)) || "Someone";
        handleMessage({ from, text: m.text, via: "telegram", chatId: m.chat && m.chat.id });
      }
    } catch (e) {
      tg.error = e.message;
      console.error("[telegram]", e.message);
      await sleep(3000);
    }
  }
}

// ---------- web server ----------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
async function readBody(req) { let raw = ""; for await (const c of req) raw += c; return raw ? JSON.parse(raw) : {}; }

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split("?")[0];
    if (req.method === "POST" && url === "/api/message") {
      const b = await readBody(req);
      if (!b.text || !String(b.text).trim()) return json(res, 400, { error: "empty message" });
      const msg = await handleMessage({ from: b.from || "Someone", text: String(b.text).trim(), via: "web", today: b.today });
      return json(res, 200, { ok: true, status: msg.status });
    }
    if (req.method === "POST" && url === "/api/reset") {
      resetState();
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url === "/api/board") {
      return json(res, 200, {
        messages: state.messages, events: state.events, tasks: state.tasks, decisions: state.decisions,
        ai: { hasKey: PROVIDERS.length > 0, source: state.lastSource, working },
        telegram: tg,
      });
    }
    if (req.method === "GET" && url === "/api/calendar.ics") {
      res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="catchup.ics"' });
      return res.end(buildIcs());
    }
    if (req.method === "GET" && url === "/api/demo-chat") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(fs.readFileSync(path.join(__dirname, "demo-chat.json")));
    }
    // static files
    let p = url === "/" ? "/index.html" : url;
    const file = path.join(__dirname, "public", path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(path.join(__dirname, "public")) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e.message) });
  }
});

server.listen(PORT, () => {
  console.log(`Catchup running at http://localhost:${PORT}`);
  console.log(
    PROVIDERS.length
      ? `AI keys found for: ${PROVIDERS.map((p) => p.name).join(", ")} (live AI mode).`
      : "No AI key found: running on cached demo outputs only."
  );
  if (tg.enabled) telegramLoop();
  else console.log("No TELEGRAM_BOT_TOKEN set: Telegram is off (the web chat still works).");
});
