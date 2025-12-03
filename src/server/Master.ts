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
// --- NEW ACCOUNT IMPORTS ---
import { Pool } from "pg"; 
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { URLSearchParams } from 'url';

const config = getServerConfigFromServer();

// --- CRITICAL FIX: Worker Limit (Prevents 502/Memory Crash) ---
// @ts-ignore
config.numWorkers = () => 1;
// ---------------------------------------------------------------

// --- DATABASE CONNECTION & AUTH SETUP ---
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});
const JWT_SECRET = "CollegeWarsSecretKey123";

// --- Rank System Definitions (9 Tiers) ---
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
    // 1. Ensure the base users table exists (using Discord ID for primary identity)
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        discord_id VARCHAR(255) UNIQUE, 
        username VARCHAR(50), 
        email VARCHAR(255), 
        wins INT DEFAULT 0,
        games_played INT DEFAULT 0,
        rank_tier VARCHAR(50) DEFAULT 'UNRANKED', 
        rank_xp INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // NOTE: Old migration columns (like password_hash) are removed to simplify Discord auth.
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

const __filename = fileURLToPath(import.meta.url);
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

// --- Main Game Helpers ---

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

// --- NEW DISCORD CALLBACK ROUTE ---

app.get("/api/discord/callback", async (req, res) => {
    const authCode = req.query.code as string;
    
    if (!authCode) {
        return res.status(400).send("Discord authentication code missing.");
    }
    
    // 1. Get Client ID and Secret securely from environment variables
    // NOTE: Ensure DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are set in Railway Variables
    const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
    const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
    const REDIRECT_URI = "https://www.collegewarsio.com/api/discord/callback"; // Must match your Discord App setting

    if (!CLIENT_ID || !CLIENT_SECRET) {
        log.error("Missing Discord credentials in environment variables.");
        return res.status(500).send("Server configuration error.");
    }

    try {
        // 2. Exchange the temporary code for an Access Token
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: authCode,
                redirect_uri: REDIRECT_URI,
            }),
        });

        const tokenData = await tokenResponse.json();

        if (tokenData.error) {
            log.error("Discord token exchange failed:", tokenData.error_description);
            return res.status(401).send("Authentication failed: " + tokenData.error_description);
        }

        const accessToken = tokenData.access_token;

        // 3. Use the Access Token to get User Data (ID, Email, Username)
        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: {
                authorization: `Bearer ${accessToken}`,
            },
        });
        
        const userData = await userResponse.json();
        const discordId = userData.id;
        const username = userData.username;

        // --- 4. Database Logic (Create/Login) ---
        let userResult = await db.query("SELECT * FROM users WHERE discord_id = $1", [discordId]);

        if (userResult.rows.length === 0) {
            // User does not exist, create new one
            userResult = await db.query(
                "INSERT INTO users (discord_id, username, email) VALUES ($1, $2, $3) RETURNING id, username, wins, rank_tier, rank_xp",
                [discordId, username, userData.email || ''] // Use email from Discord if provided
            );
        }

        const user = userResult.rows[0];

        // 5. Issue Game Session Token (JWT)
        const sessionToken = jwt.sign({ id: user.id }, JWT_SECRET);

        // Redirect back to the main game page with the token
        res.redirect(`/?token=${sessionToken}&username=${user.username}`);

    } catch (error) {
        log.error("Error during Discord OAuth flow:", error);
        res.status(500).send("Server error during login process.");
    }
});


// --- Standard Routes ---

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
