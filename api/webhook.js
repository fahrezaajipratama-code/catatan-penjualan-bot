// api/webhook.js — Catatan Penjualan Bot
// Zero dependencies: hanya menggunakan Node.js built-in (https, crypto)
// + Firestore REST API + Telegram Bot API

const https = require("https");

// ── Config ────────────────────────────────────────────────────
const TG_TOKEN   = process.env.TELEGRAM_TOKEN;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const SA         = (() => { try { return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}"); } catch(e) { return {}; } })();

// ── HTTP helpers ──────────────────────────────────────────────
function httpRequest(url, method, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const bodyStr = body
      ? (typeof body === "string" ? body : JSON.stringify(body))
      : null;
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        ...(headers || {})
      }
    };
    const req = https.request(opts, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function tgSend(chatId, text) {
  const payload = { chat_id: chatId, text, parse_mode: "HTML" };
  console.log("[tgSend] to:", chatId, "text length:", text.length);
  const res = await httpRequest(
    `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
    "POST",
    payload
  );
  if (!res.ok) console.error("[tgSend] error:", JSON.stringify(res));
  return res;
}

// ── JWT / Google OAuth2 untuk Firestore REST ──────────────────
const crypto = require("crypto");

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function getGoogleToken() {
  const now = Math.floor(Date.now() / 1000);
  const header  = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: SA.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, iat: now
  })));
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const sig = base64url(sign.sign(SA.private_key));
  const jwt = `${header}.${payload}.${sig}`;

  const res = await httpRequest(
    "https://oauth2.googleapis.com/token", "POST",
    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  return res.access_token;
}

// ── Firestore REST helpers ────────────────────────────────────
let _token = null, _tokenExp = 0;
async function token() {
  const now = Date.now() / 1000;
  if (!_token || now > _tokenExp - 60) { _token = await getGoogleToken(); _tokenExp = now + 3600; }
  return _token;
}

const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function toFS(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number") return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  if (typeof val === "string") return { stringValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFS) } };
  if (typeof val === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(val).map(([k,v])=>[k,toFS(v)])) } };
  return { stringValue: String(val) };
}

function fromFS(fields) {
  if (!fields) return {};
  const result = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v.stringValue  !== undefined) result[k] = v.stringValue;
    else if (v.integerValue !== undefined) result[k] = Number(v.integerValue);
    else if (v.doubleValue  !== undefined) result[k] = v.doubleValue;
    else if (v.booleanValue !== undefined) result[k] = v.booleanValue;
    else if (v.nullValue    !== undefined) result[k] = null;
    else if (v.arrayValue)  result[k] = (v.arrayValue.values || []).map(x => fromFS(x.mapValue?.fields || {x}).x ?? fromFSVal(x));
    else if (v.mapValue)    result[k] = fromFS(v.mapValue.fields || {});
  }
  return result;
}

function fromFSVal(v) {
  if (v.stringValue  !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue  !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.arrayValue)  return (v.arrayValue.values || []).map(fromFSVal);
  if (v.mapValue)    return fromFS(v.mapValue.fields || {});
  return null;
}

async function fsGet(col) {
  const tk = await token();
  const res = await httpRequest(`${FS_BASE}/${col}?pageSize=500`, "GET", null, { Authorization: `Bearer ${tk}` });
  if (!res.documents) return [];
  return res.documents.map(d => fromFS(d.fields));
}

async function fsSet(col, id, data) {
  const tk = await token();
  const fields = Object.fromEntries(Object.entries(data).map(([k,v])=>[k,toFS(v)]));
  await httpRequest(
    `${FS_BASE}/${col}/${id}?updateMask.fieldPaths=${Object.keys(data).join("&updateMask.fieldPaths=")}`,
    "PATCH", { fields }, { Authorization: `Bearer ${tk}` }
  );
}

async function fsDel(col, id) {
  const tk = await token();
  await httpRequest(`${FS_BASE}/${col}/${id}`, "DELETE", null, { Authorization: `Bearer ${tk}` });
}

// ── Utilities ─────────────────────────────────────────────────
const fmt   = n => "Rp " + Math.round(n).toLocaleString("id-ID");
const today = () => new Date().toISOString().split("T")[0];
const uid   = () => Date.now() + Math.random();

function parseDate(raw) {
  const parts = raw.trim().split(/[\/\-\.]/);
  if (parts.length < 2) return null;
  const dd = parts[0].padStart(2,"0"), mm = parts[1].padStart(2,"0");
  const yyyy = parts[2] ? (parts[2].length===2?"20"+parts[2]:parts[2]) : new Date().getFullYear();
  const iso = `${yyyy}-${mm}-${dd}`;
  return isNaN(new Date(iso).getTime()) ? null : iso;
}
function findLike(arr, field, q) {
  return arr.find(x => x[field]?.toLowerCase().includes(q.trim().toLowerCase()));
}
function escapeHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function todayDDMM() {
  const d = new Date();
  return String(d.getDate()).padStart(2,"0") + "/" + String(d.getMonth()+1).padStart(2,"0");
}

// ── Auth ──────────────────────────────────────────────────────
async function getUser(tgUsername) {
  const users = await fsGet("appUsers");
  return users.find(u => u.telegramUsername &&
    u.telegramUsername.toLowerCase().replace("@","") === tgUsername?.toLowerCase().replace("@",""));
}

// ── Handle message ────────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text   = (msg.text || "").trim();
  const tgUser = msg.from?.username || "";

  console.log("[handleMessage] chatId:", chatId, "user:", tgUser, "text:", text);
  console.log("[handleMessage] TG_TOKEN set:", !!TG_TOKEN, "PROJECT_ID:", PROJECT_ID, "SA.email:", SA.client_email||"NOT SET");

  if (!TG_TOKEN || !PROJECT_ID || !SA.private_key) {
    console.error("[handleMessage] Missing config! TOKEN:", !!TG_TOKEN, "PROJECT:", !!PROJECT_ID, "SA:", !!SA.private_key);
    await tgSend(chatId, "⚠️ Konfigurasi bot belum lengkap. Hubungi admin.");
    return;
  }

  const user = await getUser(tgUser);
  if (!user) {
    await tgSend(chatId, `⛔ <b>Akses ditolak</b>\n\nUsername @${tgUser} belum terdaftar.\nHubungi admin untuk mendaftarkan username Telegram Anda di menu <b>Kelola User</b>.`);
    return;
  }

  const cmd = text.toLowerCase();

  const bisaLaporan = user.perms?.laporan || user.isAdmin;
  const bisaJual    = user.perms?.jual || user.isAdmin;
  const bisaBeban   = user.perms?.beban || user.isAdmin;

  if (cmd === "/start" || cmd === "/help") {
    let msg = `👋 Halo <b>${user.nama||user.username}</b>!\n\n`;
    if (bisaJual) {
      msg += `<b>Input transaksi:</b>\n`;
      msg += `<code>tanggal: DD/MM\ncabang: Nama Cabang\nNama Produk: qty</code>\n`;
      msg += `/template_transaksi — dapatkan template siap-isi (tinggal isi jumlah)\n`;
      msg += `/batal — batalkan input\n`;
    }
    if (bisaBeban) {
      msg += `\n<b>Input beban penjualan:</b>\n`;
      msg += `<code>beban\ntanggal: DD/MM\ncabang: Nama Cabang\nkasir: nominal\nNama Item, jumlah\nNama Item Baru, jumlah, harga, satuan</code>\n`;
      msg += `Item yang namanya cocok dengan <b>Item Template</b> otomatis pakai harga & satuan template (cukup isi jumlah). Item wajib (mis. rumus 300×Cup) otomatis ikut terhitung. Jumlah boleh pakai koma, mis. <code>1,5</code>.\n`;
      msg += `/template_beban — dapatkan template siap-isi (tinggal isi jumlah)\n`;
      msg += `/beban_hari — ringkasan beban hari ini\n`;
      msg += `/beban_bulan — ringkasan beban bulan ini\n`;
    }
    if (bisaLaporan) {
      msg += `\n<b>Laporan penjualan:</b>\n`;
      msg += `/laporan_hari — hari ini\n`;
      msg += `/laporan_bulan — bulan ini\n`;
      msg += `/laporan_cabang — per cabang\n`;
      msg += `/cek — stok bahan kritis`;
    }
    await tgSend(chatId, msg);
    return;
  }
  if (cmd === "/batal") { await tgSend(chatId, "✅ Dibatalkan."); return; }

  // Template siap-isi
  if (cmd === "/template_transaksi" || cmd === "/template") {
    if (!bisaJual) { await tgSend(chatId, "⛔ Anda tidak memiliki akses untuk mencatat transaksi."); return; }
    await sendTemplateTransaksi(chatId, user);
    return;
  }
  if (cmd === "/template_beban") {
    if (!bisaBeban) { await tgSend(chatId, "⛔ Anda tidak memiliki akses beban penjualan."); return; }
    await sendTemplateBeban(chatId, user);
    return;
  }


  // Beban penjualan
  if (cmd === "/beban_hari" || cmd === "/beban_bulan") {
    if (!bisaBeban) { await tgSend(chatId, "⛔ Anda tidak memiliki akses beban penjualan."); return; }
    if (cmd === "/beban_hari")  { await sendLaporanBeban(chatId, "hari", user); return; }
    if (cmd === "/beban_bulan") { await sendLaporanBeban(chatId, "bulan", user); return; }
  }
  if (text.toLowerCase().startsWith("beban") || (cmd.includes("tanggal") && cmd.includes("kasir"))) {
    if (!bisaBeban) { await tgSend(chatId, "⛔ Anda tidak memiliki akses beban penjualan."); return; }
    await parseBebanInput(chatId, text, user);
    return;
  }

  // Laporan — hanya untuk user dengan akses laporan
  if (cmd === "/laporan_hari" || cmd === "/laporan_bulan" || cmd === "/laporan_cabang" || cmd === "/cek") {
    if (!bisaLaporan) {
      await tgSend(chatId, "⛔ Anda tidak memiliki akses untuk melihat laporan.\n\nHubungi admin jika diperlukan.");
      return;
    }
    if (cmd === "/laporan_hari")   { await sendLaporan(chatId, "hari", user); return; }
    if (cmd === "/laporan_bulan")  { await sendLaporan(chatId, "bulan", user); return; }
    if (cmd === "/laporan_cabang") { await sendLaporanCabang(chatId, user); return; }
    if (cmd === "/cek")            { await sendStokKritis(chatId); return; }
  }

  // Catat transaksi — hanya untuk user dengan akses jual
  if (cmd.includes("tanggal") || cmd.includes("cabang") || /\d+\/\d+/.test(cmd)) {
    if (!bisaJual) {
      await tgSend(chatId, "⛔ Anda tidak memiliki akses untuk mencatat transaksi.");
      return;
    }
  }

  if (cmd.includes("tanggal") || cmd.includes("cabang") || /\d+\/\d+/.test(cmd)) {
    if (!bisaJual) {
      await tgSend(chatId, "⛔ Anda tidak memiliki akses untuk mencatat transaksi.");
      return;
    }
    await parseTrx(chatId, text, user);
    return;
  }

  await tgSend(chatId, "❓ Tidak dikenali. Kirim /help untuk bantuan.");
}

// ── Parse transaksi ───────────────────────────────────────────
async function parseTrx(chatId, text, user) {
  const lines = text.split("\n").map(l=>l.trim()).filter(Boolean);
  let tgl = null, cabangQ = null;
  const itemLines = [];

  for (const line of lines) {
    const low = line.toLowerCase();
    if (low.startsWith("tanggal"))     tgl     = parseDate(line.replace(/tanggal\s*[:：]?\s*/i,"").trim());
    else if (low.startsWith("cabang")) cabangQ = line.replace(/cabang\s*[:：]?\s*/i,"").trim();
    else if (/[:：]/.test(line))       itemLines.push(line);
  }

  if (!tgl)     { await tgSend(chatId, "⚠️ Format tanggal salah. Gunakan: <code>tanggal: DD/MM</code>"); return; }
  if (!cabangQ) { await tgSend(chatId, "⚠️ Cabang tidak ditemukan. Sertakan: <code>cabang: Nama Cabang</code>"); return; }

  const [cabangs, produks, bahans, transaksis] = await Promise.all([
    fsGet("cabangs"), fsGet("produks"), fsGet("bahans"), fsGet("transaksis")
  ]);

  const cabang = findLike(cabangs, "nama", cabangQ);
  if (!cabang) {
    await tgSend(chatId, `⚠️ Cabang "<b>${cabangQ}</b>" tidak ditemukan.\n\nTersedia:\n${cabangs.map(c=>`• ${c.nama}`).join("\n")}`);
    return;
  }
  if (user.cabangId && user.cabangId !== cabang.id) {
    const allowed = cabangs.find(c=>c.id===user.cabangId);
    await tgSend(chatId, `⛔ Anda hanya bisa input untuk cabang <b>${allowed?.nama||"yang ditetapkan"}</b>.`);
    return;
  }
  if (!itemLines.length) { await tgSend(chatId, "⚠️ Tidak ada produk. Format: <code>Nama Produk: qty</code>"); return; }

  const items = [];
  const notFound = [];
  for (const line of itemLines) {
    const ci = line.lastIndexOf(":");
    const namaRaw = line.substring(0,ci).trim();
    const qtyRaw = line.substring(ci+1).replace(/\D/g,"");
    const qty = qtyRaw === "" ? 1 : parseInt(qtyRaw); // kosong = anggap 1 (kompatibilitas lama)
    if (!qty || qty <= 0) continue; // baris dengan jumlah 0 dilewati (tidak dianggap error, tidak tersimpan)
    const produk = findLike(produks,"nama",namaRaw);
    if (!produk) { notFound.push(namaRaw); continue; }
    items.push({ produk, qty });
  }
  if (notFound.length) {
    await tgSend(chatId, `⚠️ Produk tidak ditemukan: <b>${notFound.join(", ")}</b>\n\nTersedia:\n${produks.map(p=>`• ${p.nama}`).join("\n")}`);
    return;
  }
  if (!items.length) { await tgSend(chatId, "⚠️ Tidak ada produk dengan jumlah > 0. Isi angka jumlah terlebih dahulu."); return; }

  // Catatan: stok bahan baku TIDAK lagi dipengaruhi oleh transaksi — bahan baku
  // hanya dipakai untuk resep produk & menghitung HPP (samakan dengan aplikasi web).

  const existing = transaksis.find(t=>t.tgl===tgl && String(t.cabangId)===String(cabang.id));
  let totalOmzet=0, totalLaba=0;
  const snap = items.map(({produk,qty})=>{
    const sub=produk.jual*qty, laba=(produk.jual-produk.hpp)*qty;
    totalOmzet+=sub; totalLaba+=laba;
    return { produkId:produk.id, nama:produk.nama, qty, jual:produk.jual, hpp:produk.hpp,
      subtotal:sub, laba, satuan:produk.satuan,
      resepSnapshot:(produk.resep||[]).map(r=>{const b=bahans.find(x=>String(x.id)===String(r.bahanId));return{nama:b?.nama||"?",qty:r.qty*qty,satuan:b?.satuan||""};}),
    };
  });

  const trxId = existing ? existing.id : uid();
  await fsSet("transaksis", trxId, {...(existing||{}), id:trxId, tgl, cabangId:cabang.id,
    cabangNama:cabang.nama, catatan:`via Telegram @${user.telegramUsername||user.username}`,
    items:snap, total:totalOmzet, laba:totalLaba });

  // Update stok produk jadi (stok bahan baku tidak diubah)
  for (const {produk,qty} of items) {
    const p = produks.find(x=>x.id===produk.id);
    if (p) await fsSet("produks", p.id, {...p, stok:Math.max(0,p.stok-qty)});
  }

  const totalQty = items.reduce((s,x)=>s+x.qty,0);
  const fmtTgl   = new Date(tgl).toLocaleDateString("id-ID",{day:"2-digit",month:"long",year:"numeric"});
  let reply = `${existing?"✏️ <b>Transaksi diperbarui</b>":"✅ <b>Transaksi dicatat</b>"}\n\n`;
  reply += `📅 <b>${fmtTgl}</b>\n🏪 <b>${cabang.nama}</b>\n`;
  reply += `──────────────────\n`;
  items.forEach(({produk,qty})=> reply+=`• ${produk.nama} ×${qty} → <b>${fmt(produk.jual*qty)}</b>\n`);
  reply += `──────────────────\n`;
  reply += `🛒 Total qty: <b>${totalQty}</b>\n💰 Total omzet: <b>${fmt(totalOmzet)}</b>`;

  const kritis = bahans.filter(b=>b.stok<=b.min);
  if (kritis.length) reply += `\n\n⚠️ <b>Stok menipis:</b> ${kritis.map(b=>b.nama).join(", ")}`;
  await tgSend(chatId, reply);
}

// ── Template siap-isi (transaksi & beban) ──────────────────────
async function sendTemplateTransaksi(chatId, user) {
  const [produks, cabangs] = await Promise.all([fsGet("produks"), fsGet("cabangs")]);
  if (!produks.length) { await tgSend(chatId, "⚠️ Belum ada data produk. Tambahkan dulu lewat aplikasi web."); return; }
  const cabangNama = user.cabangId ? (cabangs.find(c=>String(c.id)===String(user.cabangId))?.nama||"") : "";
  const namaSorted = [...produks].sort((a,b)=>a.nama.localeCompare(b.nama));
  let tpl = `tanggal: ${todayDDMM()}\ncabang: ${cabangNama}\n`;
  tpl += namaSorted.map(p=>`${p.nama}: 0`).join("\n");
  const msg = `📝 <b>Template Transaksi</b>\nSalin pesan di bawah ini, ganti angka <b>0</b> dengan jumlah terjual (baris yang tetap 0 boleh dihapus atau dibiarkan — tidak akan tersimpan), lalu kirim kembali ke bot ini.\n\n<pre>${escapeHtml(tpl)}</pre>`;
  await tgSend(chatId, msg);
}

async function sendTemplateBeban(chatId, user) {
  const [bebanTemplate, cabangs, bebanWajib] = await Promise.all([
    fsGet("bebanTemplate"), fsGet("cabangs"), fsGet("bebanWajib")
  ]);
  if (!bebanTemplate.length) { await tgSend(chatId, "⚠️ Belum ada Item Template beban. Tambahkan dulu lewat menu Template Item di aplikasi web."); return; }
  const cabangNama = user.cabangId ? (cabangs.find(c=>String(c.id)===String(user.cabangId))?.nama||"") : "";
  const namaSorted = [...bebanTemplate].sort((a,b)=>a.nama.localeCompare(b.nama));
  let tpl = `beban\ntanggal: ${todayDDMM()}\ncabang: ${cabangNama}\nkasir: 0\n`;
  tpl += namaSorted.map(t=>`${t.nama}, 0`).join("\n");
  let note = "";
  if (bebanWajib.length) {
    note = `\n\nℹ️ Item wajib (<b>${bebanWajib.map(w=>w.nama).join(", ")}</b>) otomatis ikut terhitung mengikuti item template di atas — tidak perlu diisi manual.`;
  }
  const msg = `📝 <b>Template Beban Penjualan</b>\nSalin pesan di bawah ini, ganti angka <b>0</b> dengan jumlah (baris yang tetap 0 boleh dihapus atau dibiarkan — tidak akan tersimpan), isi juga <b>kasir</b>, lalu kirim kembali ke bot ini.\n\n<pre>${escapeHtml(tpl)}</pre>${note}`;
  await tgSend(chatId, msg);
}


async function sendLaporan(chatId, periode, user) {
  const transaksis = await fsGet("transaksis");
  const td = today(), bln = td.slice(0,7);
  let data = transaksis;
  let label = "";
  if (periode==="hari") { data=data.filter(t=>t.tgl===td); label=new Date(td).toLocaleDateString("id-ID",{day:"2-digit",month:"long",year:"numeric"}); }
  else { data=data.filter(t=>t.tgl.startsWith(bln)); const [y,m]=bln.split("-"); label=["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"][+m-1]+" "+y; }
  if (user.cabangId) data=data.filter(t=>String(t.cabangId)===String(user.cabangId));
  if (!data.length) { await tgSend(chatId,`📊 Belum ada transaksi untuk ${label}.`); return; }

  const totOmzet=data.reduce((s,t)=>s+t.total,0), totLaba=data.reduce((s,t)=>s+t.laba,0);
  const totQty=data.reduce((s,t)=>s+t.items.reduce((a,x)=>a+x.qty,0),0);
  const byP={};
  data.forEach(t=>t.items.forEach(x=>{if(!byP[x.nama])byP[x.nama]=0;byP[x.nama]+=x.qty;}));
  const produkRows=Object.entries(byP).sort((a,b)=>b[1]-a[1]).map(([n,q])=>`  • ${n}: ×${q}`).join("\n");
  const byCab={};
  data.forEach(t=>{const k=t.cabangNama||"-";if(!byCab[k])byCab[k]={o:0,t:0};byCab[k].o+=t.total;byCab[k].t++;});
  const cabRows=Object.entries(byCab).sort((a,b)=>b[1].o-a[1].o).map(([n,d])=>`  🏪 ${n}: <b>${fmt(d.o)}</b> (${d.t} trx)`).join("\n");

  let msg=`📊 <b>Laporan ${label}</b>\n──────────────────\n`;
  msg+=`🧾 Transaksi: <b>${data.length}</b>\n🛒 Total qty: <b>${totQty}</b>\n💰 Omzet: <b>${fmt(totOmzet)}</b>\n`;
  if (user.perms?.lihat_laba) msg+=`📈 Laba: <b>${fmt(totLaba)}</b>\n`;
  msg+=`\n<b>Produk terjual:</b>\n${produkRows}`;
  if (Object.keys(byCab).length>1) msg+=`\n\n<b>Per cabang:</b>\n${cabRows}`;
  await tgSend(chatId, msg);
}

async function sendLaporanCabang(chatId, user) {
  const [transaksis, cabangs] = await Promise.all([fsGet("transaksis"), fsGet("cabangs")]);
  const bln=today().slice(0,7);
  const [y,m]=bln.split("-");
  const label=["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"][+m-1]+" "+y;
  let data=transaksis.filter(t=>t.tgl.startsWith(bln));
  if (user.cabangId) data=data.filter(t=>String(t.cabangId)===String(user.cabangId));
  if (!data.length) { await tgSend(chatId,`📊 Belum ada transaksi bulan ${label}.`); return; }

  const cabIds=[...new Set(data.map(t=>t.cabangId))];
  let msg=`🏪 <b>Laporan Per Cabang — ${label}</b>`;
  for (const cid of cabIds) {
    const cNama=cabangs.find(c=>String(c.id)===String(cid))?.nama||"Tanpa cabang";
    const cd=data.filter(t=>String(t.cabangId)===String(cid));
    const cO=cd.reduce((s,t)=>s+t.total,0), cL=cd.reduce((s,t)=>s+t.laba,0);
    const cQ=cd.reduce((s,t)=>s+t.items.reduce((a,x)=>a+x.qty,0),0);
    const byP={};cd.forEach(t=>t.items.forEach(x=>{if(!byP[x.nama])byP[x.nama]=0;byP[x.nama]+=x.qty;}));
    const top3=Object.entries(byP).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([n,q])=>`${n}×${q}`).join(", ");
    msg+=`\n──────────────────\n🏪 <b>${cNama}</b>\n  Qty: ${cQ} | Omzet: <b>${fmt(cO)}</b>`;
    if (user.perms?.lihat_laba) msg+=` | Laba: <b>${fmt(cL)}</b>`;
    msg+=`\n  Top: ${top3||"-"}`;
  }
  await tgSend(chatId, msg);
}

async function sendStokKritis(chatId) {
  const bahans = await fsGet("bahans");
  const kritis = bahans.filter(b=>b.stok<=b.min);
  if (!kritis.length) { await tgSend(chatId,"✅ Semua stok bahan baku aman."); return; }
  const rows=kritis.map(b=>`• ${b.nama}: <b>${b.stok} ${b.satuan}</b> (min:${b.min})${b.stok<=0?" 🚨 HABIS":" ⚠️"}`).join("\n");
  await tgSend(chatId,`⚠️ <b>Bahan kritis:</b>\n\n${rows}`);
}


// ── Beban Penjualan ───────────────────────────────────────────
async function parseBebanInput(chatId, text, user) {
  const lines = text.split("\n").map(l=>l.trim()).filter(Boolean);
  let tgl=null, cabangQ=null, kasir=0;
  const itemLines=[];
  for (const line of lines) {
    const low=line.toLowerCase();
    if(low==='beban') continue;
    if(low.startsWith("tanggal"))     tgl=parseDate(line.replace(/tanggal\s*[:：]?\s*/i,"").trim());
    else if(low.startsWith("cabang")) cabangQ=line.replace(/cabang\s*[:：]?\s*/i,"").trim();
    else if(low.startsWith("kasir"))  kasir=parseInt(line.replace(/kasir\s*[:：]?\s*/i,"").replace(/[^0-9]/g,""))||0;
    else if(line.includes(","))       itemLines.push(line);
  }
  if(!tgl)     { await tgSend(chatId,"⚠️ Format tanggal salah. Contoh: <code>tanggal: 18/06</code>"); return; }
  if(!cabangQ) { await tgSend(chatId,"⚠️ Cabang tidak ditemukan. Sertakan: <code>cabang: Nama Cabang</code>"); return; }
  if(!itemLines.length) {
    await tgSend(chatId,"⚠️ Tidak ada item beban.\nUntuk item template, cukup: <code>Nama Item, jumlah</code> (harga & satuan ikut template)\nUntuk item baru: <code>Nama Item, jumlah, harga[, satuan]</code>\nContoh:\n<code>Cup, 120</code>\n<code>Gula, 5, 19000, kg</code>");
    return;
  }
  const [cabangs, bebanTemplate, bebanWajib] = await Promise.all([
    fsGet("cabangs"), fsGet("bebanTemplate"), fsGet("bebanWajib")
  ]);
  const cabang=cabangs.find(c=>c.nama.toLowerCase().includes(cabangQ.toLowerCase()));
  if(!cabang){ await tgSend(chatId,`⚠️ Cabang tidak ditemukan.\n\nTersedia:\n${cabangs.map(c=>"• "+c.nama).join("\n")}`); return; }
  if(user.cabangId && user.cabangId!==cabang.id){
    const allowed=cabangs.find(c=>c.id===user.cabangId);
    await tgSend(chatId,"⛔ Anda hanya bisa input untuk cabang <b>"+(allowed?.nama||"-")+"</b>."); return;
  }

  // Pisahkan input menjadi Item Template (harga & satuan otomatis dari template) dan Item Tambahan (manual)
  const tplItems=[], addItems=[];
  const tplQtyByName={}; // nama template (lowercase) -> jumlah, dipakai untuk hitung Item Wajib
  for(const line of itemLines){
    const parts=line.split(",").map(p=>p.trim());
    if(parts.length<2) continue;
    const namaRaw=parts[0];
    const jumlah=parseFloat((parts[1]||"").replace(",","."))||0;
    if(!namaRaw||!jumlah) continue;
    const tpl=findLike(bebanTemplate,"nama",namaRaw);
    if(tpl && parts.length===2){
      tplItems.push({nama:tpl.nama,jumlah,harga:tpl.harga,satuan:tpl.satuan||"",total:jumlah*tpl.harga});
      tplQtyByName[tpl.nama.toLowerCase()]=jumlah;
      continue;
    }
    const harga=parseInt((parts[2]||"").replace(/[^0-9]/g,""))||0;
    const satuan=parts[3]||"";
    if(!harga) continue; // item baru wajib sertakan harga
    addItems.push({nama:namaRaw,jumlah,harga,satuan,total:jumlah*harga});
    if(tpl) tplQtyByName[tpl.nama.toLowerCase()]=jumlah;
  }
  if(!tplItems.length && !addItems.length){
    await tgSend(chatId,"⚠️ Tidak ada item valid.\nItem template: <code>Nama, jumlah</code>\nItem baru: <code>Nama, jumlah, harga[, satuan]</code>");
    return;
  }

  // Item Wajib — otomatis dihitung (mis. "Lain-lain" = pengali × jumlah "Cup")
  const wajibItems=[];
  for(const w of bebanWajib){
    const qty=tplQtyByName[(w.linkTpl||"").toLowerCase()]||0;
    const h=(w.pengali||0)*qty;
    if(h>0){
      const satuan=(bebanTemplate.find(t=>t.nama===w.linkTpl)||{}).satuan||"";
      wajibItems.push({nama:w.nama,jumlah:1,harga:h,satuan,total:h,linkTpl:w.linkTpl,pengali:w.pengali});
    }
  }

  const allItems=[...tplItems,...wajibItems,...addItems];
  const totalBeban=allItems.reduce((s,r)=>s+r.total,0);
  const transaksis=await fsGet("transaksis");
  const totalPenjualan=transaksis.filter(t=>t.tgl===tgl&&String(t.cabangId)===String(cabang.id)).reduce((s,t)=>s+t.total,0);
  const bebans=await fsGet("bebans");
  const existing=bebans.find(b=>b.tgl===tgl&&String(b.cabangId)===String(cabang.id));
  const id=existing?existing.id:uid();
  await fsSet("bebans",id,{id,tgl,cabangId:cabang.id,cabangNama:cabang.nama,
    catatan:"via Telegram @"+(user.telegramUsername||user.username),
    kasir,totalBeban,totalPenjualan,sisaKasir:kasir-totalBeban,labaKotor:totalPenjualan-totalBeban,
    tplItems,wajibItems,addItems,items:allItems,updatedBy:user.username});
  const fmtTgl=new Date(tgl).toLocaleDateString("id-ID",{day:"2-digit",month:"long",year:"numeric"});
  const showLaba=user.perms?.lihat_laba;
  let reply=`${existing?"✏️ <b>Beban diperbarui</b>":"✅ <b>Beban dicatat</b>"}\n\n📅 <b>${fmtTgl}</b>  🏪 <b>${cabang.nama}</b>\n──────────────────\n`;
  allItems.forEach(r=>reply+=`• ${r.nama}: ${r.jumlah}${r.satuan?" "+r.satuan:""} × ${fmt(r.harga)} = <b>${fmt(r.total)}</b>\n`);
  reply+=`──────────────────\n📦 Total Beban: <b>${fmt(totalBeban)}</b>\n💵 Sisa Kasir: <b>${fmt(kasir-totalBeban)}</b>`;
  if(showLaba) reply+=`\n📈 Laba Kotor: <b>${fmt(totalPenjualan-totalBeban)}</b>`;
  await tgSend(chatId,reply);
}

async function sendLaporanBeban(chatId, periode, user) {
  const bebans=await fsGet("bebans");
  const td=today(), bln=td.slice(0,7);
  let data=bebans, label="";
  if(periode==="hari"){data=data.filter(b=>b.tgl===td);label=new Date(td).toLocaleDateString("id-ID",{day:"2-digit",month:"long",year:"numeric"});}
  else{data=data.filter(b=>b.tgl&&b.tgl.startsWith(bln));const[y,m]=bln.split("-");label=["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"][+m-1]+" "+y;}
  if(user.cabangId) data=data.filter(b=>String(b.cabangId)===String(user.cabangId));
  if(!data.length){await tgSend(chatId,"📊 Belum ada catatan beban untuk "+label+".");return;}
  const showLaba=user.perms?.lihat_laba;
  let msg="📊 <b>Beban Penjualan — "+label+"</b>";
  for(const b of data){
    msg+="\n──────────────────\n🏪 <b>"+(b.cabangNama||"-")+"</b>  📅 "+b.tgl+"\n";
    (b.items||[]).forEach(r=>{msg+="  • "+r.nama+": "+r.jumlah+(r.satuan?" "+r.satuan:"")+" × "+fmt(r.harga)+" = "+fmt(r.total)+"\n";});
    msg+="  📦 Total Beban: <b>"+fmt(b.totalBeban||0)+"</b>\n";
    msg+="  💵 Sisa Kasir: <b>"+fmt(b.sisaKasir||0)+"</b>";
    if(showLaba) msg+="\n  📈 Laba Kotor: <b>"+fmt(b.labaKotor||0)+"</b>";
    msg+="\n";
  }
  await tgSend(chatId,msg);
}

// ── Vercel export ─────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== "POST") { return res.status(200).send("Bot aktif ✅"); }
  console.log("[webhook] method:", req.method, "body keys:", Object.keys(req.body||{}));
  try {
    const { message } = req.body || {};
    if (message) {
      console.log("[webhook] from:", message.from?.username, "text:", message.text);
      await handleMessage(message);
    } else {
      console.log("[webhook] no message in body:", JSON.stringify(req.body).slice(0,200));
    }
  } catch(e) {
    console.error("[webhook] error:", e.message, e.stack?.slice(0,300));
  }
  res.status(200).json({ok:true});
};
