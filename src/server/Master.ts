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
// --- REQUIRED IMPORTS FOR DB ---
import { Pool } from "pg"; 

// --- Database connection (Setup Pool) ---
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// --- Rank System Definitions ---
const TIER_ORDER = [
  "UNRANKED",
  "BRONZE",
  "SILVER",
  "GOLD",
  "PLATINUM",
  "CHAMPION",
  "GRAND_CHAMPION",
  "HEROIC_CHAMPION",
  "MASTER_CHAMPION",
  "MASTERS",
];

const RANK_THRESHOLDS: Record<string, number> = {
  UNRANKED: 0,
  BRONZE: 1000,
  SILVER: 2500,
  GOLD: 5000,
  PLATINUM: 8000,
  CHAMPION: 12000,
  GRAND_CHAMPION: 18000,
  HEROIC_CHAMPION: 25000,
  MASTER_CHAMPION: 35000,
  MASTERS: 50000,
};

function getRankTier(xp: number): string {
  let currentTier = "UNRANKED";
  for (const tier of TIER_ORDER) {
    // If current XP meets or exceeds the threshold for this tier
    if (xp >= RANK_THRESHOLDS[tier]) {
      currentTier = tier;
    } else {
      // Since tiers are ordered, we can stop checking once XP is too low
      break; 
    }
  }
  return currentTier;
}

// --- CRITICAL FIX: Worker Limit (Prevents 502/Memory Crash) ---
// @ts-ignore
config.numWorkers = () => 1;
// ---------------------------------------------------------------

const playlist = new MapPlaylist();
const readyWorkers = new Set();

const app = express();
const server = http.createServer(app);

const log = logger.child({ comp: "m" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Database Init Function (Automated Migration) ---
async function // --- FUNCTION TO CREATE TABLE AND ADD RANK COLUMNS ---

async function initDB() {
  try {
    // 1. Ensure the base users table exists
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        wins INT DEFAULT 0,
        games_played INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // 2. ADD RANK COLUMNS (If they don't exist yet - this is safe to run multiple times)
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

    logger.info("Database initialized: Rank columns verified/added.");
  } catch (err) {
    logger.error("Database initialization failed:", err);
  }
}
    
    // 2. ADD RANK COLUMNS (If they don't exist yet - using DO $$ block for safety)
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

  log.info(`Primary ${process.pid} is running`);
  log.info(`Setting up ${NUM_WORKERS} workers...`);

  for (let i = 0; i < NUM_WORKERS; i++) {
    const worker = cluster.fork({ WORKER_ID: i });
    log.info(`Started worker ${i} (PID: ${worker.process.pid})`);
  }

  cluster.on("message", (worker, message) => {
    if (message.type === "WORKER_READY") {
      const workerId = message.workerId;
      readyWorkers.add(workerId);
      log.info(`Worker ${workerId} is ready. (${readyWorkers.size}/${NUM_WORKERS} ready)`);

      if (readyWorkers.size === NUM_WORKERS) {
        log.info("All workers ready, starting game scheduling");
        const scheduleLobbies = () => {
          schedulePublicGame(playlist).catch((error) => {
            log.error("Error scheduling public game:", error);
          });
        };
        setInterval(() => {
          fetchLobbies().then((lobbies) => {
            if (lobbies === 0) scheduleLobbies();
          });
        }, 100);
      }
    }
  });

  cluster.on("exit", (worker, code, signal) => {
    const workerId = (worker as any).process?.env?.WORKER_ID;
    if (workerId) cluster.fork({ WORKER_ID: workerId });
  });

  const PORT = parseInt(process.env.PORT || "3000");
  const HOST = "0.0.0.0";
  server.listen(PORT, HOST, () => {
    log.info(`Master HTTP server listening on port ${PORT} and host ${HOST}`);
  });
}

// --- Routes ---

// NEW: Report Game Result (Needed to update Rank/XP)
app.post("/api/report-game", async (req, res) => {
  const { userId, result } = req.body; 

  if (!userId || !["win", "loss"].includes(result)) {
    return res.status(400).send("Invalid request");
  }

  try {
    // 1. Fetch current stats
    const userRes = await db.query("SELECT rank_xp, wins, games_played FROM users WHERE id = $1", [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).send("User not found");
    }

    let currentXP = userRes.rows[0].rank_xp;
    let wins = userRes.rows[0].wins;
    let gamesPlayed = userRes.rows[0].games_played;

    // 2. Calculate new stats
    const baseXP = 50;
    const winBonus = result === "win" ? 100 : 0;
    const totalXP = baseXP + winBonus;

    currentXP += totalXP;
    wins += (result === "win" ? 1 : 0);
    gamesPlayed += 1;

    // 3. Calculate new tier
    const newTier = getRankTier(currentXP);

    // 4. Save back to DB
    await db.query(
      "UPDATE users SET rank_xp = $1, rank_tier = $2, wins = $3, games_played = $4 WHERE id = $5",
      [currentXP, newTier, wins, gamesPlayed, userId]
    );

    res.json({ userId, rank_xp: currentXP, rank_tier: newTier, wins, games_played: gamesPlayed });
  } catch (err) {
    logger.error("Error updating rank:", err);
    res.status(500).send("Internal server error");
  }
});


app.get("/api/env", async (req, res) => {
  const envConfig = { game_env: process.env.GAME_ENV };
  if (!envConfig.game_env) return res.sendStatus(500);
  res.json(envConfig);
});

app.get("/api/public_lobbies", async (req, res) => {
  res.send(publicLobbiesJsonStr);
});

app.post("/api/kick_player/:gameID/:clientID", async (req, res) => {
  if (req.headers[config.adminHeader()] !== config.adminToken()) {
    return res.status(401).send("Unauthorized");
  }
  const { gameID, clientID } = req.params;
  if (!ID.safeParse(gameID).success || !ID.safeParse(clientID).success) {
    res.sendStatus(400);
    return;
  }
  try {
    const response = await fetch(
      `http://localhost:${config.workerPort(gameID)}/api/kick_player/${gameID}/${clientID}`,
      { method: "POST", headers: { [config.adminHeader()]: config.adminToken() } }
    );
    if (!response.ok) {
      throw new Error(`Failed to kick player: ${response.statusText}`);
    }
    res.sendStatus(200);
  } catch (error) {
    log.error(`Error kicking player from game ${gameID}:`, error);
    res.sendStatus(500);
  }
});

app.get("*", function (req, res) {
  res.sendFile(path.join(__dirname, "../../static/index.html"));
});
