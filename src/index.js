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
const RESET_TOKEN = process.env.RESET_TOKEN || "";

const logger = pino({ level: "silent" });

// Shared state for the QR web page
let currentQR = null;
let botStatus = "starting"; // "starting" | "qr" | "connected"
let activeSock = null;

function clearAuthState() {
  if (fs.existsSync(AUTH_PATH)) {
    fs.rmSync(AUTH_PATH, { recursive: true, force: true });
  }
  fs.mkdirSync(AUTH_PATH, { recursive: true });
}

const HTML = {
  wrap: (title, body) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${title}</title>
<style>
  *{box-sizing:border-box;}
  body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
    min-height:100vh;margin:0;background:#f5f5f5;}
  .box{text-align:center;padding:2.5rem 3rem;border-radius:1rem;background:#fff;
    box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;width:100%;}
  h1,h2{margin:.5rem 0;} p{color:#666;margin:.4rem 0;}
  .btn{display:inline-block;margin-top:1.5rem;padding:.65rem 1.4rem;border-radius:.5rem;
    background:#dc2626;color:#fff;text-decoration:none;font-size:.9rem;cursor:pointer;
    border:none;}
  .btn:hover{background:#b91c1c;}
  small{color:#aaa;}
</style></head>
<body><div class="box">${body}</div></body></html>`,

  connected: (resetUrl) => HTML.wrap("Ziad Bot", `
    <h1>✅ Bot Connected</h1>
    <p>WhatsApp is linked and the bot is running.</p>
    ${resetUrl ? `<br><a class="btn" href="${resetUrl}" onclick="return confirm('This will disconnect the current number and show a new QR. Continue?')">🔄 Switch number / Re-scan</a>` : ""}
  `),

  waiting: () => HTML.wrap("Ziad Bot — Starting", `
    <meta http-equiv="refresh" content="3">
    <h2>⏳ Generating QR code…</h2>
    <p>This page refreshes automatically.</p>
  `),

  qr: (qrDataURL, resetUrl) => HTML.wrap("Ziad Bot — Scan QR", `
    <meta http-equiv="refresh" content="30">
    <h2>📱 Scan with WhatsApp</h2>
    <p>Open WhatsApp → Linked Devices → Link a Device</p>
    <img src="${qrDataURL}" width="280" height="280" alt="QR Code"
      style="display:block;margin:1.2rem auto;border:6px solid #f0f0f0;border-radius:.5rem;"/>
    <small>Auto-refreshes every 30s &nbsp;·&nbsp; QR expires after ~60s</small>
    ${resetUrl ? `<br><a class="btn" href="${resetUrl}" style="margin-top:1rem;background:#555;"
      onclick="return confirm('Generate a fresh QR for a different number?')">🔄 Use different number</a>` : ""}
  `),

  reset: () => HTML.wrap("Ziad Bot — Reset", `
    <meta http-equiv="refresh" content="3;url=/">
    <h2>🔄 Session cleared</h2>
    <p>Redirecting to QR page…</p>
  `),

  forbidden: () => HTML.wrap("Ziad Bot — Forbidden", `<h2>🚫 Invalid reset token</h2>`),
};

// ── QR web server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // /reset?token=xxxx
  if (url.pathname === "/reset") {
    if (!RESET_TOKEN || url.searchParams.get("token") !== RESET_TOKEN) {
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML.forbidden());
      return;
    }

    console.log("Reset requested — clearing auth state and reconnecting…");
    currentQR = null;
    botStatus = "starting";

    try { activeSock?.end(); } catch {}
    clearAuthState();
    setTimeout(startBot, 500);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML.reset());
    return;
  }

  if (url.pathname !== "/") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const resetUrl = RESET_TOKEN ? `/reset?token=${RESET_TOKEN}` : null;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

  if (botStatus === "connected") {
    res.end(HTML.connected(resetUrl));
    return;
  }

  if (!currentQR) {
    res.end(HTML.waiting());
    return;
  }

  let qrDataURL;
  try {
    qrDataURL = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
  } catch {
    res.end("Error generating QR. Try refreshing.");
    return;
  }

  res.end(HTML.qr(qrDataURL, resetUrl));
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

  const sock = (activeSock = makeWASocket({
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
  }));

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
