// server.js (simplified, removed search, enhanced for reliability)
const express = require("express");
const cookieParser = require("cookie-parser");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "6mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// --- DB init
const DB_FILE = path.join(__dirname, "db.sqlite");
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) {
    console.error("DB open error:", err);
    process.exit(1);
  }
  console.log("SQLite opened:", DB_FILE);
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS pastes (
    id TEXT PRIMARY KEY,
    title TEXT COLLATE NOCASE,
    content TEXT,
    owner_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_created ON pastes(created_at)`);
});

// helpers
function genId(len = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function genToken(len = 64) {
  return crypto.randomBytes(Math.ceil(len/2)).toString("hex").slice(0, len);
}

// Create unique paste with retry on constraint error
function insertUnique(title, content, token, cb, attempt = 0) {
  if (attempt > 5) {
    return cb(new Error("Too many attempts to generate unique ID"));
  }
  const id = genId(10);
  db.run("INSERT INTO pastes (id, title, content, owner_token) VALUES (?, ?, ?, ?)",
    [id, title, content, token],
    function(err) {
      if (err) {
        if (err.code === "SQLITE_CONSTRAINT" && err.message.includes("UNIQUE constraint failed: pastes.id")) {
          console.warn(`ID collision on attempt ${attempt + 1}: ${id}`);
          return insertUnique(title, content, token, cb, attempt + 1);
        }
        return cb(err);
      }
      return cb(null, id);
    });
}

// ===== API =====

// Create new paste
app.post("/api/new", (req, res) => {
  try {
    const { title = "Untitled", content } = req.body || {};
    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: "Nội dung không được để trống!" });
    }
    if (Buffer.byteLength(content, "utf8") > 5 * 1024 * 1024) {
      return res.status(400).json({ error: "Dung lượng vượt quá 5MB!" });
    }

    const owner_token = genToken(64);
    insertUnique(title, content, owner_token, (err, id) => {
      if (err) {
        console.error("Insert err:", err);
        return res.status(500).json({ error: "Lỗi lưu DB" });
      }
      const baseUrl = process.env.NODE_ENV === 'production' ? 'https://freepaste1.onrender.com' : `http://localhost:${PORT}`;
      const pasteUrl = `${baseUrl}/${id}`;
      const rawUrl = `${baseUrl}/raw/${id}`;
      res.cookie("owner_token", owner_token, { maxAge: 10 * 365 * 24 * 3600 * 1000, httpOnly: false, sameSite: "lax", secure: process.env.NODE_ENV === 'production' });
      console.log(`Saved paste id=${id} title=${title} size=${Buffer.byteLength(content,'utf8')} owner_token=${owner_token.slice(0,8)}...`);
      return res.json({ id, url: pasteUrl, raw: rawUrl, token: owner_token });
    });
  } catch (e) {
    console.error("api/new exception:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// Get paste JSON
app.get("/api/get/:id", (req, res) => {
  const id = req.params.id;
  db.get("SELECT id, title, content, created_at FROM pastes WHERE id = ?", [id], (err, row) => {
    if (err) {
      console.error("api/get err:", err);
      return res.status(500).json({ error: "DB error" });
    }
    if (!row) return res.status(404).json({ error: "Không tìm thấy paste" });
    res.json(row);
  });
});

// Raw text (GET)
app.get("/raw/:id", (req, res) => {
  const id = req.params.id;
  db.get("SELECT content FROM pastes WHERE id = ?", [id], (err, row) => {
    if (err) {
      console.error("raw err:", err);
      return res.status(500).send("DB error");
    }
    if (!row) return res.status(404).send("Not found");
    res.type("text/plain; charset=utf-8").send(row.content);
  });
});

// Is owner
app.post("/api/is_owner/:id", (req, res) => {
  const id = req.params.id;
  const token = req.body.token || req.cookies.owner_token || req.headers["x-owner-token"];
  if (!token) return res.json({ owner: false });
  db.get("SELECT owner_token FROM pastes WHERE id = ?", [id], (err, row) => {
    if (err || !row) return res.json({ owner: false });
    return res.json({ owner: row.owner_token === token });
  });
});

// Edit (owner)
app.post("/api/edit/:id", (req, res) => {
  const id = req.params.id;
  const { title = "Untitled", content, token } = req.body;
  if (!content || !String(content).trim()) return res.status(400).json({ error: "Nội dung không được để trống!" });
  if (Buffer.byteLength(content, "utf8") > 5 * 1024 * 1024) return res.status(400).json({ error: "Dung lượng vượt quá 5MB!" });

  const provided = token || req.cookies.owner_token;
  if (!provided) return res.status(403).json({ error: "Token required" });

  db.get("SELECT owner_token FROM pastes WHERE id = ?", [id], (err, row) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!row) return res.status(404).json({ error: "Không tìm thấy paste" });
    if (row.owner_token !== provided) return res.status(403).json({ error: "Không có quyền sửa" });

    db.run("UPDATE pastes SET title = ?, content = ? WHERE id = ?", [title, content, id], function(e) {
      if (e) return res.status(500).json({ error: "DB error" });
      console.log(`Paste ${id} updated by owner`);
      return res.json({ ok: true });
    });
  });
});

// Profile: list my pastes by token
app.post("/api/profile", (req, res) => {
  const token = req.body.token || req.cookies.owner_token;
  if (!token) return res.status(400).json({ error: "Token required" });
  db.all("SELECT id, title, created_at FROM pastes WHERE owner_token = ? ORDER BY created_at DESC", [token], (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });
    return res.json({ results: rows });
  });
});

// Serve view page for /:id (client will fetch content)
app.get("/:id", (req, res) => {
  const id = req.params.id;
  if (id.length !== 10 || !/^[a-zA-Z0-9]+$/.test(id)) {
    return res.status(400).send("Invalid ID");
  }
  res.sendFile(path.join(__dirname, "public", "view.html"));
});

// fallback 404
app.use((req, res) => {
  res.status(404).send("Not found");
});

// Graceful shutdown
process.on('SIGTERM', () => {
  db.close((err) => {
    if (err) console.error("DB close error:", err);
    console.log("DB closed");
    process.exit(0);
  });
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

