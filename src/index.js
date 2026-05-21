import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import pino from "pino";
import path from "path";
import fs from "fs";
import http from "http";
import { fileURLToPath } from "url";
import QRCode from "qrcode";
import { handleMessage } from "./intentHandler.js";
import dotenv from "dotenv";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_PATH =
  process.env.AUTH_PATH || path.join(__dirname, "..", "auth_state");
const ASSETS = path.join(__dirname, "..", "assets");
const PORT = process.env.PORT || 3000;

const logger = pino({ level: "silent" });

// Shared state for the QR web page
let currentQR = null;
let botStatus = "starting"; // "starting" | "qr" | "connected"

// ── QR web server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.url !== "/" && req.url !== "/status") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  if (req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: botStatus }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

  if (botStatus === "connected") {
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Ziad Bot</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0fdf4;}
.box{text-align:center;padding:2rem;border-radius:1rem;background:#fff;box-shadow:0 4px 20px rgba(0,0,0,.1);}
h1{color:#16a34a;} p{color:#555;}</style></head>
<body><div class="box"><h1>✅ Bot Connected</h1><p>WhatsApp is linked and the bot is running.</p></div></body></html>`);
    return;
  }

  if (!currentQR) {
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Ziad Bot — Waiting</title>
<meta http-equiv="refresh" content="3">
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;}
.box{text-align:center;padding:2rem;border-radius:1rem;background:#fff;box-shadow:0 4px 20px rgba(0,0,0,.1);}
h2{color:#555;}</style></head>
<body><div class="box"><h2>⏳ Generating QR code…</h2><p>This page refreshes automatically.</p></div></body></html>`);
    return;
  }

  let qrDataURL;
  try {
    qrDataURL = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
  } catch {
    res.end("Error generating QR code. Try refreshing.");
    return;
  }

  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Ziad Bot — Scan QR</title>
<meta http-equiv="refresh" content="30">
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;}
.box{text-align:center;padding:2rem;border-radius:1rem;background:#fff;box-shadow:0 4px 20px rgba(0,0,0,.1);}
h2{color:#333;margin-bottom:.5rem;} p{color:#777;margin-top:0;}
img{display:block;margin:1.5rem auto;border:6px solid #f0f0f0;border-radius:.5rem;}</style></head>
<body><div class="box">
  <h2>📱 Scan with WhatsApp</h2>
  <p>Open WhatsApp → Linked Devices → Link a Device</p>
  <img src="${qrDataURL}" width="300" height="300" alt="QR Code"/>
  <p style="font-size:.85rem;color:#aaa;">Page auto-refreshes every 30s. QR expires after ~60s.</p>
</div></body></html>`);
});

server.listen(PORT, () => {
  console.log(`QR server running on port ${PORT}`);
});

// ── Bot ───────────────────────────────────────────────────────────────────────
let retryCount = 0;
const MAX_RETRIES = 15;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);

  let version;
  try {
    const result = await fetchLatestBaileysVersion();
    version = result.version;
    console.log(`Using WA version: ${version.join(".")}`);
  } catch {
    console.warn("Could not fetch latest WA version, using Baileys default");
  }

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      botStatus = "qr";
      console.log(`QR ready — open the Railway public URL in your browser to scan it.`);
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(
        `Connection closed — status: ${statusCode ?? "unknown"}. Logged out: ${loggedOut}`
      );

      currentQR = null;
      botStatus = "starting";

      if (loggedOut) {
        console.log(
          "Logged out of WhatsApp. Delete the auth_state folder and restart to re-scan QR."
        );
        process.exit(1);
      }

      if (retryCount < MAX_RETRIES) {
        retryCount++;
        const delay = Math.min(3000 * retryCount, 30000);
        console.log(
          `Reconnecting in ${delay / 1000}s… (attempt ${retryCount}/${MAX_RETRIES})`
        );
        setTimeout(startBot, delay);
      } else {
        console.error("Max reconnect attempts reached. Exiting.");
        process.exit(1);
      }
    } else if (connection === "open") {
      retryCount = 0;
      currentQR = null;
      botStatus = "connected";
      console.log("WhatsApp bot is online and ready!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        console.error("Error handling message:", err);
      }
    }
  });

  sock.ev.on("group-participants.update", async ({ id, action }) => {
    if (action !== "add") return;
    try {
      const videoPath = path.join(ASSETS, "Introduction_Video.mp4");
      await sock.sendMessage(id, {
        video: fs.readFileSync(videoPath),
      });
    } catch (err) {
      console.error("Error sending welcome video to group:", err);
    }
  });
}

startBot().catch((err) => {
  console.error("Fatal error starting bot:", err);
  process.exit(1);
});
