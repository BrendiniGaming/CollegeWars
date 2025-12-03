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
// FIX: Reads JWT_SECRET from environment. Uses a fallback key for stability, 
// but requires the environment variable to be set for security.
const JWT_SECRET: string = process.env.JWT_SECRET || "INSECURE_FALLBACK_KEY"; 
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
// ---------------------------------------

async function initDB(): Promise<void> {
  try {
    // 1. Create the base users table (using Discord ID for primary identity)
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        discord_id VARCHAR(255) UNIQUE, 
        username VARCHAR(50), 
        email VARCHAR(255) UNIQUE, 
        wins INT DEFAULT 0,
        games_played INT DEFAULT 0,
        rank_tier VARCHAR(50) DEFAULT 'UNRANKED', 
        rank_xp INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // 2. ADD RANK COLUMNS (Safe migration block)
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

// --- Helper Functions (Standard Game Logic) ---

async function schedulePublicGame(playlist: MapPlaylist) {
  const gameID = generateID();
  publicLobbyIDs.add(gameID);
  const workerPath = config.workerPath(gameID);
  try {
    const response = await fetch(
      `http://localhost:${config.workerPort(gameID)}/api/create_game/${gameID}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [config.adminHeader()]: config.adminToken(),
        },
        body: JSON.stringify(playlist.gameConfig()),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to schedule public game: ${response.statusText}`);
    }
  } catch (error) {
    log.error(`Failed to schedule public game on worker ${workerPath}:`, error);
    throw error;
  }
}

async function fetchLobbies(): Promise<number> {
  const fetchPromises: Promise<GameInfo | null>[] = [];
  for (const gameID of new Set(publicLobbyIDs)) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5000);
    const port = config.workerPort(gameID);
    const promise = fetch(`http://localhost:${port}/api/game/${gameID}`, {
      headers: { [config.adminHeader()]: config.adminToken() },
      signal: controller.signal,
    })
      .then((resp) => resp.json())
      .then((json) => {
        return json as GameInfo;
      })
      .catch((error) => {
        log.error(`Error fetching game ${gameID}:`, error);
        publicLobbyIDs.delete(gameID);
        return null;
      });
    fetchPromises.push(promise);
  }
  const results = await Promise.all(fetchPromises);
  const lobbyInfos: GameInfo[] = results
    .filter((result) => result !== null)
    .map((gi: GameInfo) => {
      return {
        gameID: gi.gameID,
        numClients: gi?.clients?.length ?? 0,
        gameConfig: gi.gameConfig,
        msUntilStart: (gi.msUntilStart ?? Date.now()) - Date.now(),
      } as GameInfo;
    });

  lobbyInfos.forEach((l) => {
    if ("msUntilStart" in l && l.msUntilStart !== undefined && l.msUntilStart <= 250) {
      publicLobbyIDs.delete(l.gameID);
      return;
    }
    if (
      "gameConfig" in l &&
      l.gameConfig !== undefined &&
      "maxPlayers" in l.gameConfig &&
      l.gameConfig.maxPlayers !== undefined &&
      "numClients" in l &&
      l.numClients !== undefined &&
      l.gameConfig.maxPlayers <= l.numClients
    ) {
      publicLobbyIDs.delete(l.gameID);
      return;
    }
  });

  publicLobbiesJsonStr = JSON.stringify({ lobbies: lobbyInfos });
  return publicLobbyIDs.size;
}

// --- MAIN START FUNCTION ---

export async function startMaster() {
  if (!cluster.isPrimary) {
    throw new Error("startMaster() should only be called in the primary process");
  }

  // Initialize DB tables and rank columns
  await initDB(); 

  // --- CRASH FIX: Hardcode Workers to 1 ---
  const NUM_WORKERS = 1;

  log.info(`Primary ${process.pid} is running
