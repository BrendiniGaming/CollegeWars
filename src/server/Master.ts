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
import { URLSearchParams } from "url";

const config = getServerConfigFromServer();

// --- CRITICAL FIX: Worker Limit ---
config.numWorkers = () => 1;

// --- DB Connection ---
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});
const JWT_SECRET = process.env.JWT_SECRET;

// --- Rank System ---
const TIER_ORDER = [
  "UNRANKED","BRONZE","SILVER","GOLD","PLATINUM","CHAMPION",
  "GRAND_CHAMPION","HEROIC_CHAMPION","MASTER_CHAMPION","MASTERS"
];
const RANK_THRESHOLDS: Record<string, number> = {
  UNRANKED:0, BRONZE:1000, SILVER:2500, GOLD:5000, PLATINUM:8000,
  CHAMPION:12000, GRAND_CHAMPION:18000, HEROIC_CHAMPION:25000,
  MASTER_CHAMPION:35000, MASTERS:50000
};
function getRankTier(xp:number):string {
  let tier="UNRANKED";
  for(const t of TIER_ORDER){
    if(xp>=RANK_THRESHOLDS[t]) tier=t; else break;
  }
  return tier;
}

// --- DB Init ---
async function initDB():Promise<void>{
  try{
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
  }catch(err){ logger.error("DB init failed:",err); }
}

// --- Globals ---
const playlist=new MapPlaylist();
const readyWorkers=new Set();
const app=express();
const server=http.createServer(app);
const log=logger.child({comp:"m"});
const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
let publicLobbiesJsonStr="";
const publicLobbyIDs:Set<string>=new Set();

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname,"../../static")));
app.set("trust proxy",3);
app.use(rateLimit({windowMs:1000,max:20}));

// --- Helpers ---
async function schedulePublicGame(playlist:MapPlaylist){
  const gameID=generateID();
  publicLobbyIDs.add(gameID);
  await fetch(`http://localhost:${config.workerPort(gameID)}/api/create_game/${gameID}`,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      [config.adminHeader()]:config.adminToken()
    },
    body:JSON.stringify(playlist.gameConfig())
  });
}

async function fetchLobbies():Promise<number>{
  const results=await Promise.all([...publicLobbyIDs].map(async gameID=>{
    try{
      const resp=await fetch(`http://localhost:${config.workerPort(gameID)}/api/game/${gameID}`,{
        headers:{[config.adminHeader()]:config.adminToken()}
      });
      return await resp.json() as GameInfo;
    }catch{ publicLobbyIDs.delete(gameID); return null; }
  }));
  const lobbyInfos=results.filter(Boolean) as GameInfo[];
  publicLobbiesJsonStr=JSON.stringify({lobbies:lobbyInfos});
  return publicLobbyIDs.size;
}

// --- Start Master ---
export async function startMaster(){
  if(!cluster.isPrimary) throw new Error("startMaster only in primary");
  await initDB();
  const NUM_WORKERS=1;
  for(let i=0;i<NUM_WORKERS;i++){
    const worker=cluster.fork({WORKER_ID:i}); // ✅ fixed typo
    log.info(`Started worker ${i} (PID:${worker.process.pid})`);
  }
  cluster.on("message",(worker,message)=>{
    if(message.type==="WORKER_READY"){
      readyWorkers.add(message.workerId);
      if(readyWorkers.size===NUM_WORKERS){
        setInterval(async()=>{
          const lobbies=await fetchLobbies();
          if(lobbies===0) await schedulePublicGame(playlist);
        },100);
      }
    }
  });
  cluster.on("exit",(worker)=>{
    const workerId=(worker as any).process?.env?.WORKER_ID;
    if(workerId) cluster.fork({WORKER_ID:workerId});
  });
  const PORT=parseInt(process.env.PORT||"3000");
  const HOST="0.0.0.0";
  server.listen(PORT,HOST,()=>log.info(`Listening on ${PORT} host ${HOST}`));
}

// --- Routes ---
app.post("/api/report-game",async(req,res)=>{
  const {userId,result}=req.body;
  if(!userId||!["win","loss"].includes(result)) return res.status(400).send("Invalid");
  try{
    const userRes=await db.query("SELECT rank_xp,wins,games_played FROM users WHERE id=$1",[userId]);
    if(userRes.rows.length===0) return res.status(404).send("Not found");
    let {rank_xp:winsXP,wins,games_played}=userRes.rows[0];
    let currentXP=winsXP;
    games_played++;
    if(result==="win"){currentXP+=100;wins++;} else {currentXP+=25;}
    const newTier=getRankTier(currentXP);
    await db.query("UPDATE users SET rank_xp=$1,rank_tier=$2,wins=$3,games_played=$4 WHERE id=$5",
      [currentXP,newTier,wins,games_played,userId]);
    res.json({userId,rank_xp:currentXP,rank_tier:newTier,wins,games_played});
  }catch(err){logger.error("Rank update error:",err);res.status(500).send("Server error");}
});

// add other routes (discord oauth, env, public_lobbies, kick_player, etc.) here

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"../../static/index.html")));
