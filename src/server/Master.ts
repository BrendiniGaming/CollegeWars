import cluster from "cluster";
import express from "express";
import rateLimit from "express-rate-limit";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { getServerConfigFromServer } from "../core/configuration/ConfigLoader";
import { GameInfo, ID } from "../core/Schemas";
import { generateID } from "../core/Util";
import { logger } from "./Logger";
import { MapPlaylist } from "./MapPlaylist";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const config = getServerConfigFromServer();
// @ts-ignore
config.numWorkers = () => 1;

// --- ROBUST DATABASE CONNECTION ---
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});
const JWT_SECRET = "CollegeWarsSecretKey123";

async function initDB() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        wins INT DEFAULT 0,
        games_played INT DEFAULT 0,
        xp INT DEFAULT 0,
        rank_tier VARCHAR(50) DEFAULT 'Unranked',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    logger.info("Database initialized.");
  } catch (err) {
    logger.error("Database init failed:", err);
  }
}

const playlist = new MapPlaylist();
const readyWorkers = new Set();
const app = express();
const server = http.createServer(app);
const log = logger.child({ comp: "m" });
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());
app.use(express.static(path.join(__dirname, "../../static"), { maxAge: "1y" }));
app.set("trust proxy", 3);
app.use(rateLimit({ windowMs: 1000, max: 20 }));

let publicLobbiesJsonStr = "";
const publicLobbyIDs: Set<string> = new Set();

// --- ACCOUNT ROUTES ---
app.post("/api/register", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: "Missing fields" });
  try {
    const userCheck = await db.query("SELECT * FROM users WHERE email = $1 OR username = $2", [email, username]);
    if (userCheck.rows.length > 0) return res.status(400).json({ error: "User exists" });
    const hash = await bcrypt.hash(password, 10);
    const newUser = await db.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, wins",
      [username, email, hash]
    );
    res.json({ success: true, user: newUser.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    // NOTE: Select all columns including 'rank_tier' and 'xp'
    const result = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    if (result.rows.length === 0) return res.status(400).json({ error: "User not found" });
    const user = result.rows[0];
    if (!(await bcrypt.compare(password, user.password_hash))) return res.status(400).json({ error: "Invalid password" });
    const token = jwt.sign({ id: user.id }, JWT_SECRET);
    
    // 👇 MODIFICATION STARTS HERE
    res.json({ 
        success: true, 
        token, 
        user: { 
            username: user.username, 
            wins: user.wins,
            xp: user.xp,             // Assuming 'xp' is also fetched and named correctly
            rank: user.rank_tier     // Mapped from DB column 'rank_tier' to frontend expectation 'rank'
        } 
    });
    // 👆 MODIFICATION ENDS HERE
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// --- HELPER FUNCTIONS ---
async function schedulePublicGame(playlist: MapPlaylist) {
  const gameID = generateID();
  publicLobbyIDs.add(gameID);
  const workerPath = config.workerPath(gameID);
  try {
    const response = await fetch(`http://localhost:${config.workerPort(gameID)}/api/create_game/${gameID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [config.adminHeader()]: config.adminToken() },
      body: JSON.stringify(playlist.gameConfig()),
    });
    if (!response.ok) throw new Error(response.statusText);
  } catch (error) {
    log.error(`Failed to schedule game:`, error);
  }
}

async function fetchLobbies(): Promise<number> {
  const fetchPromises: Promise<GameInfo | null>[] = [];
  for (const gameID of new Set(publicLobbyIDs)) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5000);
    const port = config.workerPort(gameID);
    fetchPromises.push(fetch(`http://localhost:${port}/api/game/${gameID}`, {
      headers: { [config.adminHeader()]: config.adminToken() },
      signal: controller.signal,
    }).then((r) => r.json()).then((j) => j as GameInfo).catch(() => { publicLobbyIDs.delete(gameID); return null; }));
  }
  const results = await Promise.all(fetchPromises);
  const lobbyInfos = results.filter((r): r is GameInfo => r !== null).map((gi) => ({
    gameID: gi.gameID, numClients: gi?.clients?.length ?? 0, gameConfig: gi.gameConfig, msUntilStart: (gi.msUntilStart ?? Date.now()) - Date.now(),
  }));
  publicLobbiesJsonStr = JSON.stringify({ lobbies: lobbyInfos });
  return publicLobbyIDs.size;
}

// --- MAIN START FUNCTION ---
export async function startMaster() {
  if (!cluster.isPrimary) throw new Error("startMaster() only in primary");
  await initDB();
  const NUM_WORKERS = 1;
  log.info(`Primary ${process.pid} running. Setting up ${NUM_WORKERS} workers...`);
  for (let i = 0; i < NUM_WORKERS; i++) cluster.fork({ WORKER_ID: i });

  cluster.on("message", (worker, message) => {
    if (message.type === "WORKER_READY") {
      const workerId = message.workerId;
      readyWorkers.add(workerId);
      if (readyWorkers.size === NUM_WORKERS) {
        log.info("All workers ready.");
        setInterval(() => { fetchLobbies().then((lobbies) => { if (lobbies === 0) schedulePublicGame(playlist).catch(console.error); }); }, 100);
      }
    }
  });

  cluster.on("exit", (worker) => {
    const workerId = (worker as any).process?.env?.WORKER_ID;
    if (workerId) cluster.fork({ WORKER_ID: workerId });
  });

  const PORT = parseInt(process.env.PORT || "3000");
  server.listen(PORT, "0.0.0.0", () => {
    log.info(`Master listening on port ${PORT}`);
  });
}

app.get("/api/env", async (req, res) => res.json({ game_env: process.env.GAME_ENV }));
app.get("/api/public_lobbies", async (req, res) => res.send(publicLobbiesJsonStr));
app.post("/api/kick_player/:gameID/:clientID", async (req, res) => {
  if (req.headers[config.adminHeader()] !== config.adminToken()) return res.sendStatus(401);
  try {
    const { gameID, clientID } = req.params;
    const resp = await fetch(`http://localhost:${config.workerPort(gameID)}/api/kick_player/${gameID}/${clientID}`, { method: "POST", headers: { [config.adminHeader()]: config.adminToken() } });
    if (!resp.ok) throw new Error();
    res.sendStatus(200);
  } catch { res.sendStatus(500); }
});
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../../static/index.html")));
