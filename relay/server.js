const http = require("http");
const { WebSocketServer } = require("ws");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

// ── Config from env ──
const PORT = parseInt(process.env.PORT || "7777");
const DATA_DIR = process.env.DATA_DIR || "./data";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "change-me";
const MAX_EVENT_SIZE = parseInt(process.env.MAX_EVENT_SIZE || "8192");
const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || "30");
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS || "200");
const MAX_SUBS_PER_CONN = parseInt(process.env.MAX_SUBS_PER_CONN || "10");
const MAX_EVENTS = parseInt(process.env.MAX_EVENTS || "100000");
const ALLOWED_KINDS = (process.env.ALLOWED_KINDS || "0,1,3,5,6,7")
  .split(",")
  .map(Number);

// ── Database ──
const db = new Database(path.join(DATA_DIR, "relay.db"));
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    kind INTEGER NOT NULL,
    tags TEXT NOT NULL,
    content TEXT NOT NULL,
    sig TEXT NOT NULL,
    raw TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey);
  CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
  CREATE INDEX IF NOT EXISTS idx_events_kind_pubkey ON events(kind, pubkey);

  CREATE TABLE IF NOT EXISTS allowed_pubkeys (
    pubkey TEXT PRIMARY KEY,
    label TEXT DEFAULT '',
    added_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const stmts = {
  insertEvent: db.prepare(`
    INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, tags, content, sig, raw)
    VALUES (@id, @pubkey, @created_at, @kind, @tags, @content, @sig, @raw)
  `),
  deleteEvent: db.prepare(`DELETE FROM events WHERE id = ? AND pubkey = ?`),
  replaceEvent: db.prepare(`DELETE FROM events WHERE kind = ? AND pubkey = ?`),
  getEvent: db.prepare(`SELECT raw FROM events WHERE id = ?`),
  countEvents: db.prepare(`SELECT COUNT(*) as cnt FROM events`),
  pruneOldest: db.prepare(`
    DELETE FROM events WHERE id IN (
      SELECT id FROM events ORDER BY created_at ASC LIMIT ?
    )
  `),
  getAllowedPubkeys: db.prepare(`SELECT pubkey FROM allowed_pubkeys`),
  addPubkey: db.prepare(`
    INSERT OR IGNORE INTO allowed_pubkeys (pubkey, label, added_at)
    VALUES (?, ?, ?)
  `),
  removePubkey: db.prepare(`DELETE FROM allowed_pubkeys WHERE pubkey = ?`),
  listPubkeys: db.prepare(`SELECT pubkey, label, added_at FROM allowed_pubkeys`),
  getConfig: db.prepare(`SELECT value FROM config WHERE key = ?`),
  setConfig: db.prepare(`
    INSERT OR REPLACE INTO config (key, value, updated_at)
    VALUES (?, ?, ?)
  `),
  getAllConfig: db.prepare(`SELECT key, value FROM config`),
};

// ── Allowed pubkeys (merged from env + DB) ──
function getAllowedPubkeys() {
  const fromEnv = (process.env.ALLOWED_PUBKEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fromDb = stmts.getAllowedPubkeys.all().map((r) => r.pubkey);
  return new Set([...fromEnv, ...fromDb]);
}

function isAllowed(pubkey) {
  const allowed = getAllowedPubkeys();
  // If no pubkeys configured at all, reject all writes (secure default)
  if (allowed.size === 0) return false;
  return allowed.has(pubkey);
}

// ── Rate limiter ──
const rateBuckets = new Map();

function checkRateLimit(pubkey) {
  const now = Date.now();
  const windowMs = 60_000;
  let bucket = rateBuckets.get(pubkey);
  if (!bucket) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(pubkey, bucket);
  }
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count++;
  return bucket.count <= RATE_LIMIT_PER_MIN;
}

// Cleanup stale rate buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt + 60_000) rateBuckets.delete(key);
  }
}, 300_000);

// ── Event storage ──
function storeEvent(event) {
  // Replaceable events (kind 0, 3): delete old, insert new
  if (event.kind === 0 || event.kind === 3) {
    stmts.replaceEvent.run(event.kind, event.pubkey);
  }

  // Kind 5 = deletion
  if (event.kind === 5) {
    for (const tag of event.tags) {
      if (tag[0] === "e") {
        stmts.deleteEvent.run(tag[1], event.pubkey);
      }
    }
  }

  const raw = JSON.stringify(event);
  stmts.insertEvent.run({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: JSON.stringify(event.tags),
    content: event.content,
    sig: event.sig,
    raw,
  });

  // Prune if over limit
  const { cnt } = stmts.countEvents.get();
  if (cnt > MAX_EVENTS) {
    stmts.pruneOldest.run(cnt - MAX_EVENTS);
  }
}

// ── Query builder ──
function queryEvents(filter) {
  const conditions = [];
  const params = [];

  if (filter.ids && filter.ids.length) {
    conditions.push(`id IN (${filter.ids.map(() => "?").join(",")})`);
    params.push(...filter.ids);
  }
  if (filter.authors && filter.authors.length) {
    conditions.push(`pubkey IN (${filter.authors.map(() => "?").join(",")})`);
    params.push(...filter.authors);
  }
  if (filter.kinds && filter.kinds.length) {
    conditions.push(`kind IN (${filter.kinds.map(() => "?").join(",")})`);
    params.push(...filter.kinds);
  }
  if (filter.since) {
    conditions.push(`created_at >= ?`);
    params.push(filter.since);
  }
  if (filter.until) {
    conditions.push(`created_at <= ?`);
    params.push(filter.until);
  }

  // Tag filters (#e, #p, #t, etc.)
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith("#") && key.length === 2 && Array.isArray(values)) {
      const tagName = key[1];
      const tagConditions = values.map(() => `tags LIKE ?`);
      conditions.push(`(${tagConditions.join(" OR ")})`);
      params.push(...values.map((v) => `%["${tagName}","${v}"%`));
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filter.limit || 100, 500);

  const sql = `SELECT raw FROM events ${where} ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params).map((r) => JSON.parse(r.raw));
}

// ── WebSocket handling ──
const connections = new Set();

function handleMessage(ws, data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    ws.send(JSON.stringify(["NOTICE", "invalid JSON"]));
    return;
  }

  if (!Array.isArray(msg) || msg.length < 2) {
    ws.send(JSON.stringify(["NOTICE", "invalid message"]));
    return;
  }

  const type = msg[0];

  if (type === "EVENT") {
    handleEvent(ws, msg[1]);
  } else if (type === "REQ") {
    handleReq(ws, msg[1], msg[2]);
  } else if (type === "CLOSE") {
    handleClose(ws, msg[1]);
  } else {
    ws.send(JSON.stringify(["NOTICE", `unknown message type: ${type}`]));
  }
}

function handleEvent(ws, event) {
  // Validate basic structure
  if (!event || !event.id || !event.pubkey || !event.sig || !event.content === undefined) {
    ws.send(JSON.stringify(["OK", event?.id || "", false, "invalid: missing fields"]));
    return;
  }

  // Check event size
  const rawSize = JSON.stringify(event).length;
  if (rawSize > MAX_EVENT_SIZE) {
    ws.send(JSON.stringify(["OK", event.id, false, `invalid: event too large (${rawSize} > ${MAX_EVENT_SIZE})`]));
    return;
  }

  // Check kind whitelist
  if (!ALLOWED_KINDS.includes(event.kind)) {
    ws.send(JSON.stringify(["OK", event.id, false, `blocked: kind ${event.kind} not allowed`]));
    return;
  }

  // Check pubkey whitelist
  if (!isAllowed(event.pubkey)) {
    ws.send(JSON.stringify(["OK", event.id, false, "blocked: pubkey not authorized to write"]));
    return;
  }

  // Check rate limit
  if (!checkRateLimit(event.pubkey)) {
    ws.send(JSON.stringify(["OK", event.id, false, "rate-limited: too many events"]));
    return;
  }

  // Store event
  try {
    storeEvent(event);
    ws.send(JSON.stringify(["OK", event.id, true, ""]));

    // Broadcast to subscribers
    broadcastEvent(event);
  } catch (err) {
    ws.send(JSON.stringify(["OK", event.id, false, `error: ${err.message}`]));
  }
}

function handleReq(ws, subId, filter) {
  if (!subId || typeof subId !== "string") {
    ws.send(JSON.stringify(["NOTICE", "invalid subscription ID"]));
    return;
  }

  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    ws.send(JSON.stringify(["NOTICE", "invalid filter"]));
    return;
  }

  // Check subscription limit
  if (!ws.subs) ws.subs = new Map();
  if (ws.subs.size >= MAX_SUBS_PER_CONN && !ws.subs.has(subId)) {
    ws.send(JSON.stringify(["NOTICE", `too many subscriptions (max ${MAX_SUBS_PER_CONN})`]));
    return;
  }

  // Store subscription for live updates
  ws.subs.set(subId, filter);

  // Query existing events
  try {
    const events = queryEvents(filter);
    for (const event of events) {
      ws.send(JSON.stringify(["EVENT", subId, event]));
    }
    ws.send(JSON.stringify(["EOSE", subId]));
  } catch (err) {
    ws.send(JSON.stringify(["NOTICE", `query error: ${err.message}`]));
  }
}

function handleClose(ws, subId) {
  if (ws.subs) ws.subs.delete(subId);
}

function matchesFilter(event, filter) {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since && event.created_at < filter.since) return false;
  if (filter.until && event.created_at > filter.until) return false;

  // Tag filters
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith("#") && key.length === 2 && Array.isArray(values)) {
      const tagName = key[1];
      const eventTags = event.tags
        .filter((t) => t[0] === tagName)
        .map((t) => t[1]);
      if (!values.some((v) => eventTags.includes(v))) return false;
    }
  }

  return true;
}

function broadcastEvent(event) {
  for (const ws of connections) {
    if (ws.readyState !== 1 || !ws.subs) continue;
    for (const [subId, filter] of ws.subs) {
      if (matchesFilter(event, filter)) {
        ws.send(JSON.stringify(["EVENT", subId, event]));
      }
    }
  }
}

// ── HTTP server (admin API + WebSocket upgrade) ──
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    const { cnt } = stmts.countEvents.get();
    const allowed = getAllowedPubkeys();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      connections: connections.size,
      events: cnt,
      allowed_pubkeys: allowed.size,
      max_events: MAX_EVENTS,
    }));
    return;
  }

  // Admin: check auth
  const isAdmin = req.headers.authorization === `Bearer ${ADMIN_SECRET}`;

  // Admin: list allowed pubkeys
  if (req.method === "GET" && req.url === "/admin/pubkeys") {
    if (!isAdmin) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const fromDb = stmts.listPubkeys.all();
    const fromEnv = (process.env.ALLOWED_PUBKEYS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pk) => ({ pubkey: pk, label: "env", added_at: 0 }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pubkeys: [...fromEnv, ...fromDb] }));
    return;
  }

  // Admin: add pubkey
  if (req.method === "POST" && req.url === "/admin/pubkeys") {
    if (!isAdmin) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { pubkey, label } = JSON.parse(body);
        if (!pubkey || typeof pubkey !== "string" || pubkey.length !== 64) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid pubkey (must be 64-char hex)" }));
          return;
        }
        stmts.addPubkey.run(pubkey, label || "", Math.floor(Date.now() / 1000));
        console.log(`[admin] added pubkey: ${pubkey.slice(0, 16)}… (${label || "no label"})`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, pubkey }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Admin: remove pubkey
  if (req.method === "DELETE" && req.url?.startsWith("/admin/pubkeys/")) {
    if (!isAdmin) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const pubkey = req.url.split("/admin/pubkeys/")[1];
    stmts.removePubkey.run(pubkey);
    console.log(`[admin] removed pubkey: ${pubkey.slice(0, 16)}…`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, removed: pubkey }));
    return;
  }

  // Admin: get config
  if (req.method === "GET" && req.url === "/admin/config") {
    if (!isAdmin) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const rows = stmts.getAllConfig.all();
    const config = {};
    for (const row of rows) {
      try { config[row.key] = JSON.parse(row.value); } catch { config[row.key] = row.value; }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(config));
    return;
  }

  // Admin: set config
  if (req.method === "PUT" && req.url === "/admin/config") {
    if (!isAdmin) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const now = Math.floor(Date.now() / 1000);
        for (const [key, value] of Object.entries(data)) {
          stmts.setConfig.run(key, JSON.stringify(value), now);
        }
        console.log(`[admin] config updated: ${Object.keys(data).join(", ")}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Admin: check if setup is complete (public — no auth needed)
  if (req.method === "GET" && req.url === "/setup-status") {
    const row = stmts.getConfig.get("character");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ setup_complete: !!row }));
    return;
  }

  // NIP-11: Relay information
  if (req.method === "GET" && req.headers.accept === "application/nostr+json") {
    res.writeHead(200, { "Content-Type": "application/nostr+json" });
    res.end(JSON.stringify({
      name: "NPC No More Relay",
      description: "Private relay with pubkey whitelist",
      supported_nips: [1, 2, 9, 11],
      software: "npc-relay",
      version: "1.0.0",
      limitation: {
        max_message_length: MAX_EVENT_SIZE,
        max_subscriptions: MAX_SUBS_PER_CONN,
        max_event_tags: 100,
        auth_required: false,
        payment_required: false,
      },
    }));
    return;
  }

  // Default response
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("NPC No More Relay — connect via WebSocket");
});

// ── WebSocket server ──
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  if (connections.size >= MAX_CONNECTIONS) {
    ws.close(1013, "max connections reached");
    return;
  }

  connections.add(ws);
  ws.subs = new Map();
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`[ws] connected (${connections.size} total) from ${ip}`);

  ws.on("message", (data) => {
    try {
      handleMessage(ws, data.toString());
    } catch (err) {
      console.error("[ws] error handling message:", err);
      ws.send(JSON.stringify(["NOTICE", "internal error"]));
    }
  });

  ws.on("close", () => {
    connections.delete(ws);
    console.log(`[ws] disconnected (${connections.size} total)`);
  });

  ws.on("error", (err) => {
    console.error("[ws] error:", err.message);
    connections.delete(ws);
  });
});

// ── Start ──
server.listen(PORT, () => {
  const allowed = getAllowedPubkeys();
  console.log(`
╔══════════════════════════════════════════╗
║         NPC No More Relay v1.0          ║
╠══════════════════════════════════════════╣
║  Port:          ${String(PORT).padEnd(23)}║
║  Data dir:      ${DATA_DIR.padEnd(23)}║
║  Max events:    ${String(MAX_EVENTS).padEnd(23)}║
║  Max event size:${String(MAX_EVENT_SIZE + " bytes").padEnd(23)}║
║  Rate limit:    ${String(RATE_LIMIT_PER_MIN + "/min").padEnd(23)}║
║  Max conns:     ${String(MAX_CONNECTIONS).padEnd(23)}║
║  Allowed kinds: ${ALLOWED_KINDS.join(",").padEnd(23)}║
║  Auth pubkeys:  ${String(allowed.size).padEnd(23)}║
╚══════════════════════════════════════════╝
  `);
});
