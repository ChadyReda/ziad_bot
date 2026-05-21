import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, "..", "assets");
function toJID(raw) {
  // Strip spaces, dashes, +
  let n = raw.replace(/[\s\-+]/g, "");
  // 0XXXXXXXXX → 212XXXXXXXXX
  if (n.startsWith("0")) n = "212" + n.slice(1);
  // XXXXXXXXX (9 digits, no country code) → 212XXXXXXXXX
  if (n.length === 9) n = "212" + n;
  return n + "@s.whatsapp.net";
}

if (!process.env.ADMIN_NUMBER) {
  console.warn("⚠️  ADMIN_NUMBER is not set — admin notifications will fail.");
}

const ADMIN_JID = process.env.ADMIN_NUMBER
  ? toJID(process.env.ADMIN_NUMBER)
  : "";

const businessInfo = fs
  .readFileSync(path.join(ASSETS, "business-details.txt"), "utf-8")
  .trim();

const firstMessageSent = new Set();
const handedOffUsers = new Set();

const VIP_RE = /\b(vip|vap)\b/i;
const SHIPPING_RE =
  /\b(livraison|livreson|livrasion|taw9il|wasl|توصيل|delivery|tawsil|شحن|إرسال)\b/i;
const LOCATION_RE =
  /\b(fin|feen|wain|où|location|adresse|address|عنوان|فين|وين)\b/i;
const QUALITY_RE =
  /\b(original|quality|jood|jawda|asli|7qiqi|mazboot|sha7n|katsha7n|tsha7n|charge|charging|charg|ched|chedo|kay ched|batiria|batiri|4h|ki chad|sa3at|ساعة|أصلي|جودة|حقيقي|337|sony)\b/i;

const SHIPPING_REPLY =
  `🚚 *تفاصيل التوصيل:*\n\n` +
  `⚡ كازا: 19dh\n` +
  `⚡ المدن الكبرى (مراكش، أكادير...): 29dh\n` +
  `⚡ نواحي المدن: 35dh\n\n` +
  `⏱️ *مدة التوصيل:*\n` +
  `🏙️ المدن الكبرى: ~24 ساعة\n` +
  `🏘️ باقي المدن: 24-48 ساعة`;

function getMessageText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ""
  ).trim();
}

function getSenderPhone(msg) {
  const jid = msg.key.participant || msg.key.remoteJid;
  return jid.split("@")[0];
}

async function sendText(sock, jid, text) {
  await sock.sendMessage(jid, { text });
}

async function sendImage(sock, jid, filePath) {
  await sock.sendMessage(jid, { image: fs.readFileSync(filePath) });
}

async function sendAudio(sock, jid, filePath) {
  await sock.sendMessage(jid, {
    audio: fs.readFileSync(filePath),
    mimetype: "audio/ogg; codecs=opus",
    ptt: true,
  });
}

async function notifyAdmin(sock, text, phone) {
  if (!ADMIN_JID) return;
  await sock.sendMessage(ADMIN_JID, {
    text,
    mentions: [`${phone}@s.whatsapp.net`],
  });
}

export async function handleMessage(sock, msg) {
  const chatJid = msg.key.remoteJid;
  const body = getMessageText(msg);
  const phone = getSenderPhone(msg);

  if (handedOffUsers.has(chatJid)) return;

  if (!firstMessageSent.has(chatJid)) {
    firstMessageSent.add(chatJid);
    await sendAudio(sock, chatJid, path.join(ASSETS, "welcom_audio.ogg"));
    await sendImage(sock, chatJid, path.join(ASSETS, "welcome-message.jpg"));
    await sendText(sock, chatJid, "أهلاً! كم تريد من الحجارة؟ 😊");
    return;
  }

  if (VIP_RE.test(body)) {
    handedOffUsers.add(chatJid);
    await notifyAdmin(
      sock,
      `👑 *VIP/VAP*\n👤 @${phone}\nيسأل عن VIP — تواصل معه مباشرة`,
      phone
    );
    return;
  }

  if (SHIPPING_RE.test(body)) {
    await sendImage(sock, chatJid, path.join(ASSETS, "livraison-details.jpeg"));
    await sendText(sock, chatJid, SHIPPING_REPLY);
    return;
  }

  if (LOCATION_RE.test(body)) {
    await sendText(
      sock,
      chatJid,
      "📍 نحن في الدار البيضاء (كازا) ونوصل لجميع مدن المغرب 🇲🇦"
    );
    return;
  }

  if (QUALITY_RE.test(body)) {
    await sendText(sock, chatJid, businessInfo);
    return;
  }

  if (!/[?؟]/.test(body)) {
    const match = body.match(/\b(\d+)\b/);
    if (match) {
      const qty = parseInt(match[1], 10);
      if (qty < 10) {
        await sendText(
          sock,
          chatJid,
          "⚠️ الحد الأدنى للطلب هو *10 حجرات*. كم تريد؟ (10، 20، 30...)"
        );
        return;
      }
      if (qty % 10 !== 0) {
        await sendText(
          sock,
          chatJid,
          "⚠️ الكمية يجب أن تكون مضاعف 10 فقط (10، 20، 30، 40...). كم تريد؟"
        );
        return;
      }
      handedOffUsers.add(chatJid);
      await notifyAdmin(
        sock,
        `🛒 *طلب جديد!*\n👤 @${phone}\n📦 الكمية المطلوبة: *${qty} حجرة*\n\nاضغط على الاسم للدخول للمحادثة ⬆️`,
        phone
      );
      return;
    }
  }

  await notifyAdmin(
    sock,
    `💬 *رسالة خارج النطاق*\n👤 @${phone}\n💬 قال: "${body}"\n\nاضغط على الاسم للدخول للمحادثة ⬆️`,
    phone
  );
}
