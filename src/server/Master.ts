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

const config = getServerConfigFromServer();

// --- CRASH FIXES (KEEP THESE) ---
// @ts-ignore
config.numWorkers = () => 1;
// --------------------------------

const playlist = new MapPlaylist();
const readyWorkers = new Set();

const app = express();
const server = http.createServer(app);

const log = logger.child({ comp: "m" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
app.use(express.json());
app.set("trust proxy", 3);
app.use(rateLimit({ windowMs: 1000, max: 20 }));

let publicLobbiesJsonStr = "";
const publicLobbyIDs: Set<string> = new Set();

export async function startMaster() {
  if (!cluster.isPrimary) {
    throw new Error("startMaster() should only be called in the primary process");
  }

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
      log.info(`Worker ${workerId} is ready.`);

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

  cluster.on("exit", (worker) => {
    const workerId = (worker as any).process?.env?.WORKER_ID;
    if (workerId) cluster.fork({ WORKER_ID: workerId });
  });

  const PORT = parseInt(process.env.PORT || "3000");
  const HOST = "0.0.0.0";
  server.listen(PORT, HOST, () => {
    log.info(`Master HTTP server listening on port ${PORT} and host ${HOST}`);
  });
}

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
  try {
    const response = await fetch(
      `http://localhost:${config.workerPort(gameID)}/api/kick_player/${gameID}/${clientID}`,
      { method: "POST", headers: { [config.adminHeader()]: config.adminToken() } }
    );
    if (!response.ok) throw new Error();
    res.sendStatus(200);
  } catch { res.sendStatus(500); }
});

async function fetchLobbies(): Promise<number> {
  const fetchPromises: Promise<GameInfo | null>[] = [];
  for (const gameID of new Set(publicLobbyIDs)) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5000);
    const port = config.workerPort(gameID);
    const promise = fetch(`http://localhost:${port}/api/game/${gameID}`, {
      headers: { [config.adminHeader()]: config.adminToken() },
      signal: controller.signal,
    }).then((r) => r.json()).then((j) => j as GameInfo).catch(() => { publicLobbyIDs.delete(gameID); return null; });
    fetchPromises.push(promise);
  }
  const results = await Promise.all(fetchPromises);
  const lobbyInfos: GameInfo[] = results.filter((r): r is GameInfo => r !== null).map((gi) => ({
    gameID: gi.gameID, numClients: gi?.clients?.length ?? 0, gameConfig: gi.gameConfig, msUntilStart: (gi.msUntilStart ?? Date.now()) - Date.now(),
  }));
  publicLobbiesJsonStr = JSON.stringify({ lobbies: lobbyInfos });
  return publicLobbyIDs.size;
}

async function schedulePublicGame(playlist: MapPlaylist) {
  const gameID = generateID();
  publicLobbyIDs.add(gameID);
  const workerPath = config.workerPath(gameID);
  try {
    const response = await fetch(
      `http://localhost:${config.workerPort(gameID)}/api/create_game/${gameID}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", [config.adminHeader()]: config.adminToken() },
        body: JSON.stringify(playlist.gameConfig()),
      },
    );
    if (!response.ok) throw new Error(response.statusText);
  } catch (error) {
    log.error(`Failed to schedule public game on worker ${workerPath}:`, error);
  }
}

app.get("*", function (req, res) {
  res.sendFile(path.join(__dirname, "../../static/index.html"));
});
