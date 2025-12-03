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
// --- REQUIRED IMPORTS FOR DB/AUTH ---
import { Pool } from "pg"; 
import bcrypt from "bcryptjs"; 
import jwt from "jsonwebtoken";
import { URLSearchParams } from 'url';

const config = getServerConfigFromServer();

// --- CRITICAL FIX: Worker Limit (Prevents 502/Memory Crash) ---
// @ts-ignore
config.numWorkers = () => 1;
// ---------------------------------------------------------------

// --- DATABASE CONNECTION & AUTH VARIABLES ---
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});
const JWT_SECRET = process.env.JWT_SECRET;
// --------------------------------------------

// --- Rank System Definitions ---
const TIER_ORDER = [
  "UNRANKED", "BRONZE", "SILVER", "GOLD", "PLATINUM", "CHAMPION", "GRAND_CHAMPION", 
  "HEROIC_CHAMPION", "MASTER_CHAMPION", "MASTERS",
];
const RANK_THRESHOLDS: Record<string, number> = {
  UNRANKED: 0, BRONZE: 1000, SILVER: 2500, GOLD: 5000, PLATINUM: 8000,
  CHAMPION: 12000, GRAND_CHAMPION: 18000, HEROIC_CHAMPION: 25000, 
  MASTER_CHAMPION: 35000, MASTERS: 50000,
};

function getRankTier(xp: number): string {
  let currentTier = "UNRANKED";
  for (const tier of TIER_ORDER) {
    if (xp >= RANK_THRESHOLDS[tier]) {
      currentTier = tier;
    } else {
      break; 
    }
  }
  return currentTier;
}

// --- Database Init Function ---
async function initDB(): Promise<void> {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        discord_id VARCHAR(255) UNIQUE, 
        username VARCHAR(50), 
        email VARCHAR(255) UNIQUE NULL, 
        password_hash VARCHAR(255), 
        wins INT DEFAULT 0,
        games_played INT DEFAULT 0,
        rank_tier VARCHAR(50) DEFAULT 'UNRANKED', 
        rank_xp INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await db.query(`
      DO $$ 
      BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='rank_tier') THEN
              ALTER TABLE users ADD COLUMN rank_tier VARCHAR(50) DEFAULT 'UNRANKED';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='rank_xp') THEN
              ALTER TABLE users ADD COLUMN rank_xp INTEGER DEFAULT 0;
          END IF;
      END $$;
    `);

    logger.info("Database initialized: User and Rank tables are ready.");
  } catch (err) {
    logger.error("Database initialization failed:", err);
  }
}

// ----------------------------------------------------------------

const playlist = new MapPlaylist();
const readyWorkers = new Set();
const app = express();
const server = http.createServer(app);
const log = logger.child({ comp: "m" });

const __filename = path.join(process.cwd(), 'src', 'server', 'Master.ts'); 
const __dirname = path.dirname(__filename);

// --- Middleware ---
app.use(express.json());
app.use(
  express.static(path.join(__dirname, "../../static"), {
    maxAge: "1y",
    setHeaders: (res, path) => {
      if (path.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.setHeader("ETag", "");
      } else if (path.match(/\.(js|css|svg)$/)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (path.match(/\.(bin|dat|exe|dll|so|dylib)$/)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }),
);
app.set("trust proxy", 3);
app.use(rateLimit({ windowMs: 1000, max: 20 }));

let publicLobbiesJsonStr = "";
const publicLobbyIDs: Set<string> = new Set();

// --- Helper Functions ---
async function schedulePublicGame(playlist: MapPlaylist) { /* unchanged */ }
async function fetchLobbies(): Promise<number> { /* unchanged */ }

// --- MAIN START FUNCTION ---
export async function startMaster() {
  if (!cluster.isPrimary) {
    throw new Error("startMaster() should only be called in the primary process");
  }

  await initDB(); 

  const NUM_WORKERS = 1;

  log.info(`Primary ${process.pid} is running`);
  log.info(`Setting up ${NUM_WORKERS} workers...`);

  for (let i = 0; i < NUM_WORKERS; i++) {
    const worker = cluster.fork({ WORKR_ID: i });
    log.info(`Started worker ${i} (PID: ${worker.process.pid})`);
  }

  cluster.on("message", (worker, message) => { /* unchanged */ });
  cluster.on("exit", (worker, code, signal) => { /* unchanged */ });

  const PORT = parseInt(process.env.PORT || "3000");
  const HOST = "0.0.0.0";   // <-- FIX ADDED HERE

  server.listen(PORT, HOST, () => {
    log.info(`Master HTTP server listening on port ${PORT} and host ${HOST}`);
  });
}

// --- Routes ---
app.post("/api/report-game", async (req, res) => {
  const { userId, result } = req.body; 

  if (!userId || !["win", "loss"].includes(result)) {
    return res.status(400).send("Invalid request");
  }

  try {
    const userRes = await db.query("SELECT rank_xp, wins, games_played FROM users WHERE id = $1", [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).send("User not found");
    }

    let currentXP = userRes.rows[0].rank_xp;
    let wins = userRes.rows[0].wins;
    let gamesPlayed = userRes.rows[0].games_played;

    const baseXP = 50;
    const winBonus = result === "win" ? 100 : 0;
    const totalXP = baseXP + winBonus;

    currentXP += totalXP;
    wins += (result === "win" ? 1 : 0);
    gamesPlayed += 1;

    const newTier = getRankTier(currentXP);

    await db.query(
      "UPDATE users SET rank_xp = $1, rank_tier = $2, wins = $3, games_played = $4 WHERE id = $5",
      [currentXP, newTier, wins, gamesPlayed, userId]
    );

    res.json({ userId, rank_xp: currentXP, rank_tier: newTier, wins, gamesPlayed });
  } catch (err) {
    logger.error("Error updating rank:", err);
    res.status(500).send("Internal server error");
  }
});

// ... (Discord OAuth route and other routes remain unchanged)
