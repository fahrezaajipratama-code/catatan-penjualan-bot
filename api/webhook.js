// api/webhook.js
// Telegram bot untuk Catatan Penjualan
// Deploy ke Vercel — satu file, tanpa server

const fetch = require("node-fetch");
const admin = require("firebase-admin");

// ── Firebase init (singleton) ─────────────────────────────────
if (!admin.apps.length) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}
const db = admin.firestore();

// ── Telegram helper ───────────────────────────────────────────
const TOKEN = process.env.TELEGRAM_TOKEN;
const TG = `https://api.telegram.org/bot${TOKEN}`;

async function sendMsg(chatId, text, extra = {}) {
  await fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...extra }),
  });
}

// ── Firestore helpers ─────────────────────────────────────────
async function getCollection(name) {
  const snap = await db.collection(name).get();
  return snap.docs.map((d) => d.data());
}

async function setDoc(col, id, data) {
  await db.collection(col).doc(String(id)).set(data);
}

// ── Utilities ─────────────────────────────────────────────────
const fmt = (n) =>
  "Rp " + Math.round(n).toLocaleString("id-ID");

function uid() {
  return Date.now() + Math.random();
}

// Parse "dd/mm" or "dd/mm/yyyy" → "YYYY-MM-DD"
function parseDate(raw) {
  const today = new Date();
  const parts = raw.trim().split(/[\/\-\.]/);
  if (parts.length < 2) return null;
  const dd = parts[0].padStart(2, "0");
  const mm = parts[1].padStart(2, "0");
  const yyyy = parts[2] ? (parts[2].length === 2 ? "20" + parts[2] : parts[2]) : today.getFullYear();
  const iso = `${yyyy}-${mm}-${dd}`;
  if (isNaN(new Date(iso).getTime())) return null;
  return iso;
}

// Find cabang by partial name (case-insensitive)
function findCabang(cabangs, query) {
  const q = query.trim().toLowerCase();
  return cabangs.find((c) => c.nama.toLowerCase().includes(q));
}

// Find produk by partial name
function findProduk(produks, query) {
  const q = query.trim().toLowerCase();
  return produks.find((p) => p.nama.toLowerCase().includes(q));
}

// ── Session state (in-memory, per chatId) ────────────────────
// Vercel serverless is stateless — each request may be a new instance.
// We store pending sessions in Firestore so state survives across requests.
async function getSession(chatId) {
  const doc = await db.collection("botSessions").doc(String(chatId)).get();
  return doc.exists ? doc.data() : null;
}
async function setSession(chatId, data) {
  await db.collection("botSessions").doc(String(chatId)).set(data);
}
async function clearSession(chatId) {
  await db.collection("botSessions").doc(String(chatId)).delete();
}

// ── Auth ──────────────────────────────────────────────────────
async function getUser(telegramUsername) {
  const users = await getCollection("appUsers");
  const uname = telegramUsername?.toLowerCase();
  return users.find(
    (u) =>
      u.telegramUsername &&
      u.telegramUsername.toLowerCase().replace("@", "") === uname?.replace("@", "")
  );
}

// ── Message handler ───────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const tgUsername = msg.from?.username || "";

  // ── Auth check ───────────────────────────────────────────────
  const user = await getUser(tgUsername);
  if (!user) {
    await sendMsg(
      chatId,
      `⛔ <b>Akses ditolak</b>\n\nUsername Telegram <code>@${tgUsername}</code> tidak terdaftar di aplikasi.\n\nHubungi admin untuk mendaftarkan username Telegram Anda di menu <b>Kelola User</b>.`
    );
    return;
  }

  const lower = text.toLowerCase();

  // ── Global commands ──────────────────────────────────────────
  if (lower === "/start" || lower === "/help") {
    await sendMsg(
      chatId,
      `👋 Halo <b>${user.nama || user.username}</b>!\n\n` +
      `<b>📋 Cara input transaksi:</b>\n` +
      `Kirim pesan dengan format:\n\n` +
      `<code>tanggal: DD/MM\ncabang: Nama Cabang\nMenu A: qty\nMenu B: qty\n...</code>\n\n` +
      `<b>Contoh:</b>\n` +
      `<code>tanggal: 18/06\ncabang: Malioboro\nKopi Susu: 3\nNasi Goreng: 2</code>\n\n` +
      `<b>📊 Laporan:</b>\n` +
      `/laporan_hari — laporan hari ini\n` +
      `/laporan_bulan — laporan bulan ini\n` +
      `/laporan_cabang — laporan per cabang\n\n` +
      `<b>🔧 Lainnya:</b>\n` +
      `/cek — cek stok bahan baku kritis\n` +
      `/batal — batalkan input aktif`
    );
    return;
  }

  if (lower === "/batal") {
    await clearSession(chatId);
    await sendMsg(chatId, "✅ Input dibatalkan.");
    return;
  }

  if (lower === "/laporan_hari") {
    await sendLaporan(chatId, "hari", user);
    return;
  }

  if (lower === "/laporan_bulan") {
    await sendLaporan(chatId, "bulan", user);
    return;
  }

  if (lower === "/laporan_cabang") {
    await sendLaporanCabang(chatId, user);
    return;
  }

  if (lower === "/cek") {
    await sendStokKritis(chatId);
    return;
  }

  // ── Parse multi-line transaksi input ────────────────────────
  if (
    lower.includes("tanggal") ||
    lower.includes("cabang") ||
    /\d+\/\d+/.test(lower)
  ) {
    await parseTrxInput(chatId, text, user);
    return;
  }

  // ── Unknown ──────────────────────────────────────────────────
  await sendMsg(
    chatId,
    `❓ Perintah tidak dikenali.\n\nKirim /help untuk melihat cara penggunaan.`
  );
}

// ── Parse & save transaksi ────────────────────────────────────
async function parseTrxInput(chatId, text, user) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  let tgl = null;
  let cabangQuery = null;
  const itemLines = [];

  for (const line of lines) {
    const low = line.toLowerCase();
    if (low.startsWith("tanggal")) {
      const val = line.replace(/tanggal\s*[:：]?\s*/i, "").trim();
      tgl = parseDate(val);
    } else if (low.startsWith("cabang")) {
      cabangQuery = line.replace(/cabang\s*[:：]?\s*/i, "").trim();
    } else if (/[:：]/.test(line)) {
      itemLines.push(line);
    }
  }

  // Validate date
  if (!tgl) {
    await sendMsg(
      chatId,
      `⚠️ Format tanggal tidak dikenali.\n\nGunakan format: <code>tanggal: DD/MM</code> atau <code>DD/MM/YYYY</code>`
    );
    return;
  }

  // Validate cabang
  const cabangs = await getCollection("cabangs");
  if (!cabangQuery) {
    await sendMsg(chatId, `⚠️ Cabang tidak ditemukan dalam pesan.\n\nSertakan: <code>cabang: Nama Cabang</code>`);
    return;
  }
  const cabang = findCabang(cabangs, cabangQuery);
  if (!cabang) {
    const list = cabangs.map((c) => `• ${c.nama}`).join("\n");
    await sendMsg(chatId, `⚠️ Cabang "<b>${cabangQuery}</b>" tidak ditemukan.\n\nCabang tersedia:\n${list}`);
    return;
  }

  // Check user cabang restriction
  if (user.cabangId && user.cabangId !== cabang.id) {
    const allowed = cabangs.find((c) => c.id === user.cabangId);
    await sendMsg(chatId, `⛔ Anda hanya bisa input transaksi untuk cabang <b>${allowed?.nama || "yang ditetapkan"}</b>.`);
    return;
  }

  // Parse items
  if (!itemLines.length) {
    await sendMsg(chatId, `⚠️ Tidak ada item produk yang ditemukan.\n\nFormat: <code>Nama Produk: jumlah</code>`);
    return;
  }

  const produks = await getCollection("produks");
  const bahans  = await getCollection("bahans");

  const items = [];
  const notFound = [];
  const stokWarnings = [];

  for (const line of itemLines) {
    const colonIdx = line.lastIndexOf(":");
    const namaRaw  = line.substring(0, colonIdx).trim();
    const qtyRaw   = line.substring(colonIdx + 1).trim();
    const qty      = parseInt(qtyRaw.replace(/\D/g, "")) || 1;

    const produk = findProduk(produks, namaRaw);
    if (!produk) {
      notFound.push(namaRaw);
      continue;
    }
    items.push({ produk, qty });
  }

  if (notFound.length) {
    const list = produks.map((p) => `• ${p.nama}`).join("\n");
    await sendMsg(
      chatId,
      `⚠️ Produk tidak ditemukan: <b>${notFound.join(", ")}</b>\n\nProduk tersedia:\n${list}`
    );
    return;
  }

  // Check stok bahan baku
  const butuh = {};
  for (const { produk, qty } of items) {
    for (const r of produk.resep || []) {
      if (!butuh[r.bahanId]) butuh[r.bahanId] = 0;
      butuh[r.bahanId] += r.qty * qty;
    }
  }
  for (const [bid, jml] of Object.entries(butuh)) {
    const b = bahans.find((x) => String(x.id) === String(bid));
    if (b && b.stok < jml) {
      stokWarnings.push(`⚠️ ${b.nama}: butuh ${jml} ${b.satuan}, stok ${b.stok} ${b.satuan}`);
    }
  }
  if (stokWarnings.length) {
    await sendMsg(
      chatId,
      `🚫 <b>Stok bahan tidak cukup:</b>\n${stokWarnings.join("\n")}\n\nTransaksi dibatalkan. Update stok di aplikasi terlebih dahulu.`
    );
    return;
  }

  // Check duplicate date+cabang
  const transaksis = await getCollection("transaksis");
  const existing   = transaksis.find(
    (t) => t.tgl === tgl && t.cabangId === cabang.id
  );

  // Build snap
  let totalOmzet = 0, totalLaba = 0;
  const snap = items.map(({ produk, qty }) => {
    const subtotal = produk.jual * qty;
    const laba     = (produk.jual - produk.hpp) * qty;
    totalOmzet += subtotal;
    totalLaba  += laba;
    return {
      produkId: produk.id,
      nama:     produk.nama,
      qty,
      jual:     produk.jual,
      hpp:      produk.hpp,
      subtotal,
      laba,
      satuan:   produk.satuan,
      resepSnapshot: (produk.resep || []).map((r) => {
        const b = bahans.find((x) => String(x.id) === String(r.bahanId));
        return { nama: b?.nama || "?", qty: r.qty * qty, satuan: b?.satuan || "" };
      }),
    };
  });

  const trxId   = existing ? existing.id : uid();
  const trxData = {
    ...(existing || {}),
    id:         trxId,
    tgl,
    cabangId:   cabang.id,
    cabangNama: cabang.nama,
    catatan:    `via Telegram @${user.telegramUsername || user.username}`,
    items:      snap,
    total:      totalOmzet,
    laba:       totalLaba,
  };

  // Update stok bahan & produk
  const updBahans  = bahans.map((b) => ({ ...b }));
  const updProduks = produks.map((p) => ({ ...p }));
  Object.entries(butuh).forEach(([bid, jml]) => {
    const b = updBahans.find((x) => String(x.id) === String(bid));
    if (b) b.stok = Math.max(0, b.stok - jml);
  });
  items.forEach(({ produk, qty }) => {
    const p = updProduks.find((x) => x.id === produk.id);
    if (p) p.stok = Math.max(0, p.stok - qty);
  });

  // Save all
  await setDoc("transaksis", trxId, trxData);
  for (const b of updBahans) {
    if (Object.keys(butuh).includes(String(b.id))) await setDoc("bahans", b.id, b);
  }
  for (const { produk } of items) {
    const p = updProduks.find((x) => x.id === produk.id);
    if (p) await setDoc("produks", p.id, p);
  }

  // Build reply
  const totalQty = items.reduce((s, x) => s + x.qty, 0);
  const isUpdate = !!existing;
  const fmtTgl   = new Date(tgl).toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });

  let reply = `${isUpdate ? "✏️ <b>Transaksi diperbarui</b>" : "✅ <b>Transaksi berhasil dicatat</b>"}\n\n`;
  reply += `📅 <b>${fmtTgl}</b>\n`;
  reply += `🏪 <b>${cabang.nama}</b>\n`;
  reply += `──────────────────\n`;
  items.forEach(({ produk, qty }) => {
    const sub = produk.jual * qty;
    reply += `• ${produk.nama} ×${qty} → <b>${fmt(sub)}</b>\n`;
  });
  reply += `──────────────────\n`;
  reply += `🛒 Total item: <b>${totalQty} pcs</b>\n`;
  reply += `💰 Total omzet: <b>${fmt(totalOmzet)}</b>\n`;

  // Stok kritis setelah input
  const kritis = updBahans.filter((b) => b.stok <= b.min);
  if (kritis.length) {
    reply += `\n⚠️ <b>Stok menipis:</b> ${kritis.map((b) => b.nama).join(", ")}`;
  }

  await sendMsg(chatId, reply);
}

// ── Laporan hari / bulan ──────────────────────────────────────
async function sendLaporan(chatId, periode, user) {
  const transaksis = await getCollection("transaksis");
  const today = new Date().toISOString().split("T")[0];
  const bulan = today.slice(0, 7);

  let data = transaksis;
  let label = "";
  if (periode === "hari") {
    data  = data.filter((t) => t.tgl === today);
    label = new Date(today).toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });
  } else {
    data  = data.filter((t) => t.tgl.startsWith(bulan));
    const [y, m] = bulan.split("-");
    const bulanNama = ["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"][parseInt(m)-1];
    label = `${bulanNama} ${y}`;
  }

  // Restrict to user's cabang if set
  if (user.cabangId) data = data.filter((t) => t.cabangId === user.cabangId);

  if (!data.length) {
    await sendMsg(chatId, `📊 Belum ada transaksi untuk ${label}.`);
    return;
  }

  const totOmzet = data.reduce((s, t) => s + t.total, 0);
  const totLaba  = data.reduce((s, t) => s + t.laba, 0);
  const totQty   = data.reduce((s, t) => s + t.items.reduce((a, x) => a + x.qty, 0), 0);

  // Produk summary
  const byP = {};
  data.forEach((t) =>
    t.items.forEach((x) => {
      if (!byP[x.nama]) byP[x.nama] = 0;
      byP[x.nama] += x.qty;
    })
  );
  const produkRows = Object.entries(byP)
    .sort((a, b) => b[1] - a[1])
    .map(([n, q]) => `  • ${n}: <b>×${q}</b>`)
    .join("\n");

  // Per cabang
  const byCab = {};
  data.forEach((t) => {
    const k = t.cabangNama || "Tanpa cabang";
    if (!byCab[k]) byCab[k] = { omzet: 0, trx: 0 };
    byCab[k].omzet += t.total;
    byCab[k].trx++;
  });
  const cabRows = Object.entries(byCab)
    .sort((a, b) => b[1].omzet - a[1].omzet)
    .map(([n, d]) => `  🏪 ${n}: <b>${fmt(d.omzet)}</b> (${d.trx} trx)`)
    .join("\n");

  const showLaba = user.perms?.lihat_laba;

  let msg = `📊 <b>Laporan ${label}</b>\n`;
  msg += `──────────────────\n`;
  msg += `🧾 Transaksi: <b>${data.length}</b>\n`;
  msg += `🛒 Total qty: <b>${totQty} pcs</b>\n`;
  msg += `💰 Total omzet: <b>${fmt(totOmzet)}</b>\n`;
  if (showLaba) msg += `📈 Total laba: <b>${fmt(totLaba)}</b>\n`;
  msg += `\n<b>📦 Produk terjual:</b>\n${produkRows}\n`;
  if (Object.keys(byCab).length > 1) {
    msg += `\n<b>🏪 Per cabang:</b>\n${cabRows}`;
  }

  await sendMsg(chatId, msg);
}

// ── Laporan per cabang ────────────────────────────────────────
async function sendLaporanCabang(chatId, user) {
  const transaksis = await getCollection("transaksis");
  const cabangs    = await getCollection("cabangs");
  const today      = new Date().toISOString().split("T")[0];
  const bulan      = today.slice(0, 7);
  const [y, m]     = bulan.split("-");
  const bulanNama  = ["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"][parseInt(m)-1];

  let data = transaksis.filter((t) => t.tgl.startsWith(bulan));
  if (user.cabangId) data = data.filter((t) => t.cabangId === user.cabangId);

  if (!data.length) {
    await sendMsg(chatId, `📊 Belum ada transaksi bulan ${bulanNama} ${y}.`);
    return;
  }

  const showLaba = user.perms?.lihat_laba;
  const cabangIds = [...new Set(data.map((t) => t.cabangId))];
  let msg = `🏪 <b>Laporan Per Cabang — ${bulanNama} ${y}</b>\n`;

  for (const cid of cabangIds) {
    const cNama = cabangs.find((c) => c.id === cid)?.nama || "Tanpa cabang";
    const cData = data.filter((t) => t.cabangId === cid);
    const cOmzet = cData.reduce((s, t) => s + t.total, 0);
    const cLaba  = cData.reduce((s, t) => s + t.laba, 0);
    const cQty   = cData.reduce((s, t) => s + t.items.reduce((a, x) => a + x.qty, 0), 0);
    const byP    = {};
    cData.forEach((t) => t.items.forEach((x) => { if (!byP[x.nama]) byP[x.nama] = 0; byP[x.nama] += x.qty; }));
    const top3   = Object.entries(byP).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, q]) => `${n} ×${q}`).join(", ");

    msg += `\n──────────────────\n`;
    msg += `🏪 <b>${cNama}</b>\n`;
    msg += `  Transaksi: ${cData.length} | Qty: ${cQty}\n`;
    msg += `  Omzet: <b>${fmt(cOmzet)}</b>\n`;
    if (showLaba) msg += `  Laba: <b>${fmt(cLaba)}</b>\n`;
    msg += `  Top produk: ${top3 || "-"}\n`;
  }

  await sendMsg(chatId, msg);
}

// ── Stok kritis ───────────────────────────────────────────────
async function sendStokKritis(chatId) {
  const bahans = await getCollection("bahans");
  const kritis = bahans.filter((b) => b.stok <= b.min);
  if (!kritis.length) {
    await sendMsg(chatId, "✅ Semua stok bahan baku aman.");
    return;
  }
  const rows = kritis
    .map((b) => `• ${b.nama}: <b>${b.stok} ${b.satuan}</b> (min: ${b.min})${b.stok <= 0 ? " 🚨 HABIS" : " ⚠️"}`)
    .join("\n");
  await sendMsg(chatId, `⚠️ <b>Bahan baku kritis:</b>\n\n${rows}`);
}

// ── Vercel handler ────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("Bot aktif ✅");
  }

  try {
    const { message } = req.body;
    if (message) await handleMessage(message);
  } catch (err) {
    console.error("Bot error:", err);
  }

  // Always respond 200 to Telegram immediately
  res.status(200).json({ ok: true });
};
