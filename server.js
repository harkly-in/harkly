const express = require("express");
const session = require("express-session");
const SessionStore = session.Store;
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 5000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "harkly.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_color TEXT NOT NULL DEFAULT '#8d7bff',
    bio TEXT NOT NULL DEFAULT 'Ready for a good conversation.',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_online INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS connection_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(sender_id, receiver_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL DEFAULT '',
    message_type TEXT NOT NULL DEFAULT 'text' CHECK(message_type IN ('text','image','video','audio','file')),
    file_name TEXT,
    file_path TEXT,
    file_size INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    seen_at TEXT
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    request_id INTEGER REFERENCES connection_requests(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS messages_conversation ON messages(sender_id, receiver_id, created_at);
  CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, is_read, created_at);
`);

class SQLiteSessionStore extends SessionStore {
  get(sid, callback) {
    try {
      const row = db.prepare("SELECT sess, expires FROM sessions WHERE sid = ?").get(sid);
      if (!row || row.expires <= Date.now()) {
        if (row) db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) { callback(error); }
  }
  set(sid, sess, callback) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7 * 86400000;
      db.prepare("INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires")
        .run(sid, JSON.stringify(sess), expires);
      callback?.(null);
    } catch (error) { callback?.(error); }
  }
  destroy(sid, callback) {
    try { db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid); callback?.(null); }
    catch (error) { callback?.(error); }
  }
  touch(sid, sess, callback) { this.set(sid, sess, callback); }
}

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) console.warn("SESSION_SECRET is not set; use a persistent secret in production.");
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));
app.use(session({
  name: "harkly.sid",
  secret: sessionSecret,
  store: new SQLiteSessionStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: process.env.NODE_ENV === "production",
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));
app.use(express.static(path.join(ROOT, "public"), { maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (origin && origin !== `${req.protocol}://${req.get("host")}`) return res.status(403).json({ error: "That request did not come from this app." });
  next();
});

const allowedTypes = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "video/mp4", "video/webm", "audio/webm", "audio/mpeg", "audio/ogg",
  "application/pdf", "text/plain", "application/zip", "application/octet-stream"
]);
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (allowedTypes.has(file.mimetype)) return cb(null, true);
    const error = new Error("That file type isn't supported.");
    error.statusCode = 400;
    cb(error);
  }
});

const typingUsers = new Map();
const authAttempts = new Map();
const rateBuckets = new Map();
const eventClients = new Map();
const colors = ["#8d7bff", "#ff8d8d", "#63c8a3", "#f0b86c", "#6eafff", "#d879c7"];

function now() { return new Date().toISOString(); }
function rateLimit({ windowMs = 60_000, max = 30, key = (req) => req.ip } = {}) {
  return (req, res, next) => {
    const bucketKey = key(req);
    const current = rateBuckets.get(bucketKey);
    const timestamp = Date.now();
    if (!current || timestamp - current.startedAt >= windowMs) {
      rateBuckets.set(bucketKey, { startedAt: timestamp, count: 1 });
      return next();
    }
    current.count += 1;
    if (current.count > max) {
      const retryAfter = Math.ceil((windowMs - (timestamp - current.startedAt)) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "You’re doing that a little too quickly. Please try again shortly." });
    }
    next();
  };
}
function sendEvent(userId, event, payload) {
  const clients = eventClients.get(Number(userId));
  if (!clients) return;
  const packet = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try { client.res.write(packet); } catch { clients.delete(client); }
  }
}
function sessionLogin(req, userId, callback) {
  req.session.regenerate((error) => {
    if (error) return callback(error);
    req.session.userId = Number(userId);
    req.session.save(callback);
  });
}
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, value] of rateBuckets) if (value.startedAt < cutoff) rateBuckets.delete(key);
  db.prepare("DELETE FROM sessions WHERE expires <= ?").run(Date.now());
  const typingCutoff = Date.now() - 6000;
  for (const [userId, typing] of typingUsers) {
    if (typing.at < typingCutoff) {
      typingUsers.delete(userId);
      sendEvent(typing.targetId, "typing", { fromUserId: userId, isTyping: false });
    }
  }
}, 60_000).unref();
function cleanUsername(input) {
  return String(input || "").trim().replace(/^@/, "").toLowerCase();
}
function publicUser(user) {
  if (!user) return null;
  const recent = user.last_seen && (Date.now() - new Date(user.last_seen).getTime()) < 20000;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    bio: user.bio,
    avatarColor: user.avatar_color,
    isOnline: Boolean(user.is_online) && Boolean(recent),
    lastSeen: user.last_seen,
    createdAt: user.created_at
  };
}
function currentUser(req) { return req.session.userId ? db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.userId) : null; }
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Please sign in to continue." });
  req.user = user;
  db.prepare("UPDATE users SET is_online = 1, last_seen = ? WHERE id = ?").run(now(), user.id);
  next();
}
app.get("/uploads/:filename", requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const file = db.prepare("SELECT sender_id, receiver_id, file_path FROM messages WHERE file_path = ?").get(`/uploads/${filename}`);
  const canView = file && ([file.sender_id, file.receiver_id].includes(req.user.id) || isConnected(req.user.id, file.sender_id));
  if (!canView) return res.status(404).end();
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.sendFile(path.join(UPLOAD_DIR, filename));
});
function sanitizeMessage(row, viewerId) {
  return {
    id: row.id, senderId: row.sender_id, receiverId: row.receiver_id,
    content: row.content, type: row.message_type, fileName: row.file_name,
    fileUrl: row.file_path, fileSize: row.file_size, createdAt: row.created_at,
    seenAt: row.seen_at, mine: row.sender_id === viewerId
  };
}
function isConnected(a, b) {
  return Boolean(db.prepare(`SELECT id FROM connection_requests
    WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
    AND status = 'accepted'`).get(a, b, b, a));
}
function makeNotification(userId, kind, title, body, requestId = null, messageId = null) {
  db.prepare(`INSERT INTO notifications (user_id, kind, title, body, request_id, message_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(userId, kind, title, body, requestId, messageId);
}

app.get("/api/me", (req, res) => {
  const user = currentUser(req);
  if (user) {
    db.prepare("UPDATE users SET is_online = 1, last_seen = ? WHERE id = ?").run(now(), user.id);
    return res.json({ user: publicUser({ ...user, is_online: 1, last_seen: now() }) });
  }
  res.json({ user: null });
});

app.post("/api/auth/signup", rateLimit({ windowMs: 10 * 60_000, max: 8 }), (req, res) => {
  const username = cleanUsername(req.body.username);
  const displayName = String(req.body.displayName || "").trim();
  const password = String(req.body.password || "");
  if (!/^[a-z0-9._]{3,24}$/.test(username)) return res.status(400).json({ error: "Choose a username with 3–24 letters, numbers, dots or underscores." });
  if (displayName.length < 2 || displayName.length > 40) return res.status(400).json({ error: "Your name should be between 2 and 40 characters." });
  if (password.length < 8) return res.status(400).json({ error: "Use a password with at least 8 characters." });
  if (authAttempts.get(`signup:${req.ip}`) > 25) return res.status(429).json({ error: "Too many attempts. Please try again later." });
  try {
    const hash = bcrypt.hashSync(password, 12);
    const result = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
      VALUES (?, ?, ?, ?)`).run(username, displayName, hash, colors[Math.floor(Math.random() * colors.length)]);
    db.prepare("UPDATE users SET is_online = 1, last_seen = ? WHERE id = ?").run(now(), result.lastInsertRowid);
    sessionLogin(req, result.lastInsertRowid, (error) => {
      if (error) return res.status(500).json({ error: "We couldn't start your secure session. Please try again." });
      res.status(201).json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid)) });
    });
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) return res.status(409).json({ error: "That username is already taken. Try another one." });
    res.status(500).json({ error: "We couldn't create your account. Please try again." });
  }
});

app.post("/api/auth/signin", rateLimit({ windowMs: 10 * 10 * 60_000, max: 12 }), (req, res) => {
  const identifier = cleanUsername(req.body.identifier);
  const password = String(req.body.password || "");
  const key = `signin:${req.ip}`;
  const attempts = authAttempts.get(key) || 0;
  if (attempts > 20) return res.status(429).json({ error: "Too many sign-in attempts. Please wait a little and try again." });
  const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(identifier);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    authAttempts.set(key, attempts + 1);
    return res.status(401).json({ error: "That username or password doesn't look right." });
  }
  authAttempts.delete(key);
  sessionLogin(req, user.id, (error) => {
    if (error) return res.status(500).json({ error: "We couldn't start your secure session. Please try again." });
    db.prepare("UPDATE users SET is_online = 1, last_seen = ? WHERE id = ?").run(now(), user.id);
    res.json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)) });
  });
});

app.post("/api/auth/logout", (req, res) => {
  if (req.session.userId) db.prepare("UPDATE users SET is_online = 0, last_seen = ? WHERE id = ?").run(now(), req.session.userId);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/events", requireAuth, (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders?.();
  res.write(`event: ready\ndata: ${JSON.stringify({ userId: req.user.id })}\n\n`);
  const client = { res };
  if (!eventClients.has(req.user.id)) eventClients.set(req.user.id, new Set());
  eventClients.get(req.user.id).add(client);
  const heartbeat = setInterval(() => { try { res.write(": keep-alive\n\n"); } catch {} }, 20_000);
  req.on("close", () => { clearInterval(heartbeat); eventClients.get(req.user.id)?.delete(client); });
});

app.get("/api/people", requireAuth, (req, res) => {
  const query = cleanUsername(req.query.q);
  if (!query) return res.json({ people: [] });
  const people = db.prepare(`SELECT * FROM users WHERE id != ? AND (username LIKE ? OR display_name LIKE ?)
    ORDER BY CASE WHEN lower(username) = ? THEN 0 WHEN lower(username) LIKE ? THEN 1 ELSE 2 END, display_name COLLATE NOCASE LIMIT 25`)
    .all(req.user.id, `%${query}%`, `%${req.query.q || ""}%`, query, `${query}%`);
  res.json({ people: people.map(publicUser) });
});

app.get("/api/requests", requireAuth, (req, res) => {
  const incoming = db.prepare(`SELECT r.*, u.username, u.display_name, u.avatar_color, u.is_online, u.last_seen
    FROM connection_requests r JOIN users u ON u.id = r.sender_id
    WHERE r.receiver_id = ? ORDER BY r.status = 'pending' DESC, r.created_at DESC`).all(req.user.id);
  const outgoing = db.prepare(`SELECT r.*, u.username, u.display_name, u.avatar_color, u.is_online, u.last_seen
    FROM connection_requests r JOIN users u ON u.id = r.receiver_id
    WHERE r.sender_id = ? ORDER BY r.created_at DESC`).all(req.user.id);
  const map = (r) => ({ id: r.id, status: r.status, createdAt: r.created_at, user: publicUser({ id: r.sender_id === req.user.id ? r.receiver_id : r.sender_id, username: r.username, display_name: r.display_name, avatar_color: r.avatar_color, is_online: r.is_online, last_seen: r.last_seen }) });
  res.json({ incoming: incoming.map(map), outgoing: outgoing.map(map) });
});

app.post("/api/requests/:userId", requireAuth, rateLimit({ max: 12, key: (req) => `requests:${req.user.id}` }), (req, res) => {
  const targetId = Number(req.params.userId);
  if (!targetId || targetId === req.user.id) return res.status(400).json({ error: "That connection isn't available." });
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(targetId);
  if (!target) return res.status(404).json({ error: "User not found." });
  const existing = db.prepare(`SELECT * FROM connection_requests WHERE
    (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)`).get(req.user.id, targetId, targetId, req.user.id);
  if (existing?.status === "accepted") return res.status(409).json({ error: "You are already connected." });
  if (existing?.status === "pending") return res.status(409).json({ error: existing.sender_id === req.user.id ? "Request already sent." : "They already sent you a request." });
  let request;
  if (existing) {
    db.prepare("UPDATE connection_requests SET sender_id = ?, receiver_id = ?, status = 'pending', updated_at = ? WHERE id = ?").run(req.user.id, targetId, now(), existing.id);
    request = { ...existing, sender_id: req.user.id, receiver_id: targetId, status: "pending" };
  } else {
    const result = db.prepare("INSERT INTO connection_requests (sender_id, receiver_id) VALUES (?, ?)").run(req.user.id, targetId);
    request = { id: result.lastInsertRowid };
  }
  makeNotification(targetId, "request", `${req.user.display_name} wants to connect`, `@${req.user.username} sent you a connection request.`, request.id);
  sendEvent(targetId, "notification", { kind: "request", title: `${req.user.display_name} wants to connect`, body: `@${req.user.username} sent you a connection request.` });
  res.status(201).json({ ok: true, message: "Request sent." });
});

app.patch("/api/requests/:id", requireAuth, (req, res) => {
  const request = db.prepare("SELECT * FROM connection_requests WHERE id = ? AND receiver_id = ?").get(Number(req.params.id), req.user.id);
  if (!request || request.status !== "pending") return res.status(404).json({ error: "Request not found." });
  const action = req.body.action;
  if (!["accept", "decline"].includes(action)) return res.status(400).json({ error: "Choose accept or decline." });
  const status = action === "accept" ? "accepted" : "declined";
  db.prepare("UPDATE connection_requests SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), request.id);
  const sender = db.prepare("SELECT * FROM users WHERE id = ?").get(request.sender_id);
  if (action === "accept") makeNotification(sender.id, "accepted", `${req.user.display_name} accepted your request`, "You can now start chatting.", request.id);
  if (action === "accept") sendEvent(sender.id, "notification", { kind: "accepted", title: `${req.user.display_name} accepted your request`, body: "You can now start chatting." });
  res.json({ ok: true, status, user: publicUser(sender) });
});

app.get("/api/chats", requireAuth, (req, res) => {
  const connections = db.prepare(`SELECT u.*, r.id AS request_id FROM users u
    JOIN connection_requests r ON ((r.sender_id = ? AND r.receiver_id = u.id) OR (r.receiver_id = ? AND r.sender_id = u.id))
    WHERE r.status = 'accepted' ORDER BY u.is_online DESC, u.last_seen DESC`).all(req.user.id, req.user.id);
  const chats = connections.map((person) => {
    const last = db.prepare(`SELECT * FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
      ORDER BY id DESC LIMIT 1`).get(req.user.id, person.id, person.id, req.user.id);
    const unread = db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE sender_id = ? AND receiver_id = ? AND seen_at IS NULL`).get(person.id, req.user.id).count;
    return { user: publicUser(person), lastMessage: last ? sanitizeMessage(last, req.user.id) : null, unread };
  }).sort((a, b) => (b.lastMessage?.id || 0) - (a.lastMessage?.id || 0));
  res.json({ chats });
});

app.get("/api/chats/:userId/messages", requireAuth, (req, res) => {
  const otherId = Number(req.params.userId);
  if (!isConnected(req.user.id, otherId)) return res.status(403).json({ error: "Connect with this person to chat." });
  const rows = db.prepare(`SELECT * FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
    ORDER BY id ASC LIMIT 200`).all(req.user.id, otherId, otherId, req.user.id);
  db.prepare("UPDATE messages SET seen_at = ? WHERE sender_id = ? AND receiver_id = ? AND seen_at IS NULL").run(now(), otherId, req.user.id);
  res.json({ messages: rows.map((row) => sanitizeMessage(row, req.user.id)) });
});

app.post("/api/chats/:userId/messages", requireAuth, rateLimit({ windowMs: 60_000, max: 45, key: (req) => `messages:${req.user.id}` }), upload.single("file"), (req, res) => {
  const otherId = Number(req.params.userId);
  if (!isConnected(req.user.id, otherId)) return res.status(403).json({ error: "Connect with this person to chat." });
  const recipient = db.prepare("SELECT * FROM users WHERE id = ?").get(otherId);
  if (!recipient) return res.status(404).json({ error: "User not found." });
  if (req.file && !allowedTypes.has(req.file.mimetype)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "That file type isn't supported." });
  }
  const messageType = req.file ? (req.file.mimetype.startsWith("image/") ? "image" : req.file.mimetype.startsWith("video/") ? "video" : req.file.mimetype.startsWith("audio/") ? "audio" : "file") : "text";
  const content = String(req.body.content || "").trim();
  if (content.length > 5000) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "Messages can be up to 5,000 characters." });
  }
  if (!req.file && !content) return res.status(400).json({ error: "Write a message or attach a file." });
  const result = db.prepare(`INSERT INTO messages (sender_id, receiver_id, content, message_type, file_name, file_path, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, otherId, content, messageType, req.file?.originalname || null, req.file ? `/uploads/${path.basename(req.file.path)}` : null, req.file?.size || null);
  const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(result.lastInsertRowid);
  const preview = messageType === "text" ? content.slice(0, 80) : `Sent a ${messageType}`;
  makeNotification(otherId, "message", `New message from ${req.user.display_name}`, preview, null, message.id);
  sendEvent(otherId, "message", { message: sanitizeMessage(message, otherId) });
  res.status(201).json({ message: sanitizeMessage(message, req.user.id) });
});

app.post("/api/chats/:userId/seen", requireAuth, (req, res) => {
  if (!isConnected(req.user.id, Number(req.params.userId))) return res.status(403).json({ error: "Not connected." });
  const seenAt = now();
  db.prepare("UPDATE messages SET seen_at = ? WHERE sender_id = ? AND receiver_id = ? AND seen_at IS NULL").run(seenAt, Number(req.params.userId), req.user.id);
  sendEvent(Number(req.params.userId), "seen", { byUserId: req.user.id, seenAt });
  res.json({ ok: true });
});

app.get("/api/chats/:userId/state", requireAuth, (req, res) => {
  const otherId = Number(req.params.userId);
  const person = db.prepare("SELECT is_online, last_seen FROM users WHERE id = ?").get(otherId);
  const typing = typingUsers.get(otherId);
  res.json({ isOnline: Boolean(person?.is_online) && person?.last_seen && (Date.now() - new Date(person.last_seen).getTime()) < 20000, lastSeen: person?.last_seen, isTyping: typing?.targetId === req.user.id && Date.now() - typing.at < 5000 });
});

app.post("/api/presence", requireAuth, rateLimit({ windowMs: 60_000, max: 120, key: (req) => `presence:${req.user.id}` }), (req, res) => {
  const typingTo = Number(req.body.typingTo);
  const isTyping = req.body.typing !== false;
  db.prepare("UPDATE users SET is_online = 1, last_seen = ? WHERE id = ?").run(now(), req.user.id);
  if (typingTo && isTyping) {
    typingUsers.set(req.user.id, { userId: req.user.id, targetId: typingTo, at: Date.now() });
    sendEvent(typingTo, "typing", { fromUserId: req.user.id, isTyping: true });
  } else if (typingUsers.has(req.user.id)) {
    const previous = typingUsers.get(req.user.id);
    typingUsers.delete(req.user.id);
    sendEvent(previous.targetId, "typing", { fromUserId: req.user.id, isTyping: false });
  }
  res.json({ ok: true });
});

app.get("/api/notifications", requireAuth, (req, res) => {
  const notifications = db.prepare(`SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50`).all(req.user.id);
  res.json({ notifications: notifications.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, requestId: n.request_id, messageId: n.message_id, isRead: Boolean(n.is_read), createdAt: n.created_at })) });
});
app.post("/api/notifications/read", requireAuth, (req, res) => {
  db.prepare("UPDATE notifications SET is_read = 1 WHERE user_id = ?").run(req.user.id);
  res.json({ ok: true });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE" ? "Attachments must be 25 MB or smaller." : "That attachment could not be uploaded.";
    return res.status(400).json({ error: message });
  }
  if (error) {
    console.error("Request error:", error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Something went wrong while processing that request." });
  }
  res.status(404).json({ error: "Not found." });
});

app.use((_req, res) => res.sendFile(path.join(ROOT, "public", "index.html")));

process.on("SIGTERM", () => {
  if (db) db.close();
  process.exit(0);
});
app.listen(PORT, "0.0.0.0", () => console.log(`Harkly listening on port ${PORT}`));