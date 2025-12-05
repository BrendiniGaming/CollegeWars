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
import bcrypt from "bcryptjs"; // Re-added for manual password hashing
import jwt from "jsonwebtoken";

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
const JWT_SECRET: string = process.env.JWT_SECRET || "A_VERY_LONG_FALLBACK_STRING_98765432101234567890"; // Keep secure secret
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
    // 1. Create the base users table (Restored to require Email/Password hash for manual login)
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL, 
        email VARCHAR(255) UNIQUE NOT NULL, 
        password_hash VARCHAR(255) NOT NULL, 
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

  log.info(`Primary ${process.pid} is running`);
  log.info(`Setting up ${NUM_WORKERS} workers...`);

  for (let i = 0; i < NUM_WORKERS; i++) {
    const worker = cluster.fork({ WORKR_ID: i });
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
    const workerId = (worker as any).process?.env?.WORKR_ID;
    if (workerId) cluster.fork({ WORKR_ID: workerId });
  });

  const PORT = parseInt(process.env.PORT || "3000");
  const HOST = "0.0.0.0";
  server.listen(PORT, HOST, () => {
    log.info(`Master HTTP server listening on port ${PORT} and host ${HOST}`);
  });
}

// --- Routes ---

// NEW: REGISTER
app.post("/api/register", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: "Missing fields" });

  try {
    // 1. Check if user exists
    const userCheck = await db.query("SELECT * FROM users WHERE email = $1 OR username = $2", [email, username]);
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ error: "User already exists" });
    }

    // 2. Hash password (Security)
    const hash = await bcrypt.hash(password, 10);

    // 3. Save to DB
    const newUser = await db.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, wins, rank_tier",
      [username, email, hash]
    );

    res.json({ success: true, user: newUser.rows[0] });
  } catch (err) {
    logger.error("Error during registration:", err);
    res.status(500).json({ error: "Server error during registration" });
  }
});

// NEW: LOGIN
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    // 1. Find user
    const result = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    if (result.rows.length === 0) {
      return res.status(400).json({ error: "User not found" });
    }

    const user = result.rows[0];

    // 2. Check Password
    const validPass = await bcrypt.compare(password, user.password_hash);
    if (!validPass) {
      return res.status(400).json({ error: "Invalid password" });
    }

    // 3. Create Session Token
    const token = jwt.sign({ id: user.id }, JWT_SECRET);

    res.json({ success: true, token, user: { username: user.username, wins: user.wins, rank_tier: user.rank_tier } });
  } catch (err) {
    logger.error("Error during login:", err);
    res.status(500).json({ error: "Server error during login" });
  }
});


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

    res.json({ userId, rank_xp: currentXP, rank_tier: newTier, wins, gamesPlayed: gamesPlayed });
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
