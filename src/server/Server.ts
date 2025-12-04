import cluster from "cluster";
import * as dotenv from "dotenv";
import express from "express";
import axios from "axios";

import { GameEnv } from "../core/configuration/Config";
import { getServerConfigFromServer } from "../core/configuration/ConfigLoader";
import { Cloudflare, TunnelConfig } from "./Cloudflare";
import { startMaster } from "./Master";
import { startWorker } from "./Worker";

const config = getServerConfigFromServer();

dotenv.config();

// Create the Express app
const app = express();

// --- THE DISCORD CALLBACK ROUTE (TypeScript Version) ---
app.get('/api/discord/callback', async (req, res) => {
  const code = req.query.code as string;

  if (!code) {
    return res.redirect('/?error=no_code_provided');
  }

  try {
    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID || '',
      client_secret: process.env.DISCORD_CLIENT_SECRET || '',
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: 'https://www.collegewarsio.com/api/discord/callback' // Must match EXACTLY what is in Discord Dev Portal
    });

    const tokenResponse = await axios.post(
      'https://discord.com/api/oauth2/token',
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    const accessToken = tokenResponse.data.access_token;

    res.redirect(`/?token=${accessToken}`);
  } catch (error: any) {
    console.error('Discord Auth Error:', error.response?.data || error.message);
    res.redirect('/?error=auth_failed');
  }
});

// Main entry point of the application
async function main() {
  if (cluster.isPrimary) {
    if (config.env() !== GameEnv.Dev) {
      // await setupTunnels();
    }
    console.log("Starting master process...");
    await startMaster();
  } else {
    console.log("Starting worker process...");
    await startWorker();
  }
}

// Start the application
main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});

async function setupTunnels() {
  const cloudflare = new Cloudflare(
    config.cloudflareAccountId(),
    config.cloudflareApiToken(),
    config.cloudflareConfigPath(),
    config.cloudflareCredsPath(),
  );

  const domainToService = new Map<string, string>().set(
    config.subdomain(),
    `http://localhost:80`,
  );

  for (let i = 0; i < config.numWorkers(); i++) {
    domainToService.set(
      `w${i}-${config.subdomain()}`,
      `http://localhost:${3000 + i + 1}`,
    );
  }

  if (!(await cloudflare.configAlreadyExists())) {
    await cloudflare.createTunnel({
      subdomain: config.subdomain(),
      domain: config.domain(),
      subdomainToService: domainToService,
    } as TunnelConfig);
  } else {
    console.log("Config already exists, skipping tunnel creation");
  }

  await cloudflare.startCloudflared();
}

// Start listening so the route is reachable
app.listen(80, () => {
  console.log("Express server listening on port 80");
});

