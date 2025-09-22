const express = require("express");
const cookieParser = require("cookie-parser");
const { MongoClient, ObjectId } = require("mongodb");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "6mb" }));
app.use(cookieParser());

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://<username>:<password>@<cluster>.mongodb.net/pastepinfree?retryWrites=true&w=majority";
let db;

async function connectDB() {
  if (db) return db;
  const client = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await client.connect();
  db = client.db("pastepinfree");
  console.log("Connected to MongoDB");
  return db;
}

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

// Create new paste
app.post("/api/new", async (req, res) => {
  try {
    const { title = "Untitled", content } = req.body || {};
    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: "Nội dung không được để trống!" });
    }
    if (Buffer.byteLength(content, "utf8") > 5 * 1024 * 1024) {
      return res.status(400).json({ error: "Dung lượng vượt quá 5MB!" });
    }

    const db = await connectDB();
    const owner_token = genToken(64);
    let id;
    let attempts = 0;
    const maxAttempts = 5;

    // Retry on ID collision
    while (attempts < maxAttempts) {
      id = genId(10);
      const existing = await db.collection("pastes").findOne({ id });
      if (!existing) break;
      attempts++;
    }
    if (attempts >= maxAttempts) {
      return res.status(500).json({ error: "Too many attempts to generate unique ID" });
    }

    const paste = {
      id,
      title,
      content,
      owner_token,
      created_at: new Date()
    };

    await db.collection("pastes").insertOne(paste);
    const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000";
    res.cookie("owner_token", owner_token, { maxAge: 10 * 365 * 24 * 3600 * 1000, httpOnly: false, sameSite: "lax", secure: !!process.env.VERCEL_URL });
    console.log(`Saved paste id=${id} title=${title} size=${Buffer.byteLength(content,'utf8')} owner_token=${owner_token.slice(0,8)}...`);
    return res.json({ id, url: `${baseUrl}/${id}`, raw: `${baseUrl}/raw/${id}`, token: owner_token });
  } catch (e) {
    console.error("api/new exception:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// Get paste JSON
app.get("/api/get/:id", async (req, res) => {
  try {
    const db = await connectDB();
    const paste = await db.collection("pastes").findOne({ id: req.params.id });
    if (!paste) return res.status(404).json({ error: "Không tìm thấy paste" });
    res.json({
      id: paste.id,
      title: paste.title,
      content: paste.content,
      created_at: paste.created_at.toISOString()
    });
  } catch (e) {
    console.error("api/get err:", e);
    return res.status(500).json({ error: "DB error" });
  }
});

// Raw text
app.get("/raw/:id", async (req, res) => {
  try {
    const db = await connectDB();
    const paste = await db.collection("pastes").findOne({ id: req.params.id });
    if (!paste) return res.status(404).send("Not found");
    res.type("text/plain; charset=utf-8").send(paste.content);
  } catch (e) {
    console.error("raw err:", e);
    return res.status(500).send("DB error");
  }
});

// Is owner
app.post("/api/is_owner/:id", async (req, res) => {
  try {
    const token = req.body.token || req.cookies.owner_token || req.headers["x-owner-token"];
    if (!token) return res.json({ owner: false });
    const db = await connectDB();
    const paste = await db.collection("pastes").findOne({ id: req.params.id });
    if (!paste) return res.json({ owner: false });
    return res.json({ owner: paste.owner_token === token });
  } catch (e) {
    console.error("is_owner err:", e);
    return res.json({ owner: false });
  }
});

// Edit paste
app.post("/api/edit/:id", async (req, res) => {
  try {
    const { title = "Untitled", content, token } = req.body;
    if (!content || !String(content).trim()) return res.status(400).json({ error: "Nội dung không được để trống!" });
    if (Buffer.byteLength(content, "utf8") > 5 * 1024 * 1024) return res.status(400).json({ error: "Dung lượng vượt quá 5MB!" });

    const provided = token || req.cookies.owner_token;
    if (!provided) return res.status(403).json({ error: "Token required" });

    const db = await connectDB();
    const paste = await db.collection("pastes").findOne({ id: req.params.id });
    if (!paste) return res.status(404).json({ error: "Không tìm thấy paste" });
    if (paste.owner_token !== provided) return res.status(403).json({ error: "Không có quyền sửa" });

    await db.collection("pastes").updateOne(
      { id: req.params.id },
      { $set: { title, content } }
    );
    console.log(`Paste ${req.params.id} updated by owner`);
    return res.json({ ok: true });
  } catch (e) {
    console.error("edit err:", e);
    return res.status(500).json({ error: "DB error" });
  }
});

// Profile: list my pastes
app.post("/api/profile", async (req, res) => {
  try {
    const token = req.body.token || req.cookies.owner_token;
    if (!token) return res.status(400).json({ error: "Token required" });
    const db = await connectDB();
    const pastes = await db.collection("pastes").find({ owner_token: token })
      .sort({ created_at: -1 })
      .toArray();
    return res.json({
      results: pastes.map(p => ({
        id: p.id,
        title: p.title,
        created_at: p.created_at.toISOString()
      }))
    });
  } catch (e) {
    console.error("profile err:", e);
    return res.status(500).json({ error: "DB error" });
  }
});

module.exports = app;
