require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');

const REQUIRED = [
  'DISCORD_TOKEN', 'GUILD_ID', 'PANEL_PASSWORD', 'SESSION_SECRET',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
];
for (const name of REQUIRED) {
  if (!process.env[name]) {
    console.error(`Eksik ayar: ${name}`);
    process.exit(1);
  }
}
const {
  DISCORD_TOKEN, GUILD_ID, PANEL_PASSWORD, SESSION_SECRET,
  UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
} = process.env;

process.on('unhandledRejection', (err) => console.error('Hata:', err));

// ---------- Yardımcılar ----------
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// ---------- Pano (Upstash) ----------
const KEY = 'bot:settings';
const defaults = {
  autoBan: true,
  welcomeChannelId: '',
  welcomeMessage: 'Hoş geldin {user}! 🎉 Aramıza katıldığın için çok mutluyuz.',
};

async function redis(command) {
  const res = await fetch(UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
    body: JSON.stringify(command),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function loadSettings() {
  const raw = await redis(['GET', KEY]);
  return { ...defaults, ...(raw ? JSON.parse(raw) : {}) };
}

async function saveSettings(cfg) {
  await redis(['SET', KEY, JSON.stringify(cfg)]);
}

// ---------- Discord ----------
async function discord(method, path, reason) {
  const headers = {
    Authorization: `Bot ${DISCORD_TOKEN}`,
    'User-Agent': 'DiscordBot (discord-panel, 1.0)',
  };
  if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason);
  const res = await fetch(`https://discord.com/api/v10${path}`, { method, headers });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.message) || `Discord hatası (${res.status})`);
  return data;
}

async function getTextChannels() {
  const all = await discord('GET', `/guilds/${GUILD_ID}/channels`);
  return all.filter((c) => c.type === 0 || c.type === 5).sort((a, b) => a.position - b.position);
}

// ---------- Sayfa şablonları ----------
const page = (body) => `<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Bot Paneli</title>
<style>
body{font-family:system-ui,sans-serif;background:#1e1f22;color:#dbdee1;max-width:760px;margin:30px auto;padding:0 16px}
h1,h2{color:#fff}
.card{background:#2b2d31;border-radius:8px;padding:16px;margin-bottom:16px}
input,select,textarea{width:100%;padding:8px;margin:6px 0 12px;background:#1e1f22;color:#fff;border:1px solid #3f4147;border-radius:4px;box-sizing:border-box}
input[type=checkbox]{width:auto;margin-right:8px}
button{background:#5865f2;color:#fff;border:0;padding:8px 14px;border-radius:4px;cursor:pointer}
button.red{background:#da373c}
table{width:100%;border-collapse:collapse}
td,th{padding:6px;text-align:left;border-bottom:1px solid #3f4147}
.msg{background:#248046;padding:8px 12px;border-radius:4px;margin-bottom:16px}
.err{background:#da373c;padding:8px 12px;border-radius:4px;margin-bottom:16px}
</style></head><body>${body}</body></html>`;

const loginPage = (error) =>
  page(`<h1>🔒 Bot Paneli</h1><div class="card">
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <form method="post" action="/login">
    <label>Şifre</label>
    <input type="password" name="password" autofocus>
    <button>Giriş Yap</button>
  </form></div>`);

// ---------- Uygulama ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  next();
});

app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(
  session({
    name: 'panel.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 1000 * 60 * 60 * 8 },
  })
);

const requireAuth = (req, res, next) => (req.session.auth ? next() : res.redirect('/login'));
const flash = (req, text) => { req.session.flash = text; };

app.get('/health', (req, res) => res.send('ok'));

// Şifre deneme sınırı: 10 dakikada en fazla 5 yanlış deneme
const attempts = new Map();

app.get('/login', (req, res) => res.send(loginPage()));

app.post('/login', (req, res) => {
  const now = Date.now();
  const rec = (attempts.get(req.ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (rec.length >= 5) {
    return res.status(429).send(loginPage('Çok fazla deneme. 10 dakika sonra tekrar dene.'));
  }
  if (safeEqual(req.body.password || '', PANEL_PASSWORD)) {
    attempts.delete(req.ip);
    return req.session.regenerate((err) => {
      if (err) return res.status(500).send(loginPage('Bir hata oluştu.'));
      req.session.auth = true;
      res.redirect('/');
    });
  }
  rec.push(now);
  attempts.set(req.ip, rec);
  res.send(loginPage('Şifre yanlış.'));
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/', requireAuth, async (req, res) => {
  const msg = req.session.flash;
  delete req.session.flash;
  try {
    const [me, guild, channels, bans, cfg] = await Promise.all([
      discord('GET', '/users/@me'),
      discord('GET', `/guilds/${GUILD_ID}?with_counts=true`),
      getTextChannels(),
      discord('GET', `/guilds/${GUILD_ID}/bans?limit=1000`),
      loadSettings(),
    ]);

    const options = channels
      .map((c) => `<option value="${c.id}" ${c.id === cfg.welcomeChannelId ? 'selected' : ''}>#${esc(c.name)}</option>`)
      .join('');

    const rows = bans
      .map(
        (b) => `<tr>
        <td>${esc(b.user.global_name || b.user.username)}</td>
        <td>${esc(b.user.id)}</td>
        <td>${esc(b.reason || '-')}</td>
        <td><form method="post" action="/unban">
          <input type="hidden" name="id" value="${esc(b.user.id)}">
          <button class="red">Banı Aç</button></form></td></tr>`
      )
      .join('');

    res.send(
      page(`
      <h1>🤖 Bot Paneli</h1>
      ${msg ? `<div class="${msg.startsWith('Hata') ? 'err' : 'msg'}">${esc(msg)}</div>` : ''}
      <div class="card">
        <b>Bot:</b> ${esc(me.username)} &nbsp;|&nbsp;
        <b>Sunucu:</b> ${esc(guild.name)} &nbsp;|&nbsp;
        <b>Üye:</b> ${esc(guild.approximate_member_count || '?')}
        <form method="post" action="/logout" style="float:right"><button>Çıkış</button></form>
      </div>

      <div class="card">
        <h2>Ayarlar</h2>
        <form method="post" action="/settings">
          <label><input type="checkbox" name="autoBan" ${cfg.autoBan ? 'checked' : ''}>
            Sunucudan çıkanları otomatik banla</label>
          <label>Karşılama kanalı</label>
          <select name="welcomeChannelId">${options}</select>
          <label>Karşılama mesajı (<code>{user}</code> yazan yere yeni üyenin etiketi gelir)</label>
          <textarea name="welcomeMessage" rows="3">${esc(cfg.welcomeMessage)}</textarea>
          <button>Kaydet</button>
        </form>
        <p style="font-size:13px;opacity:.7">Değişiklikler bota en geç 15 saniye içinde ulaşır.</p>
      </div>

      <div class="card">
        <h2>Banlı Kullanıcılar (${bans.length})</h2>
        <table>
          <tr><th>Kullanıcı</th><th>ID</th><th>Sebep</th><th></th></tr>
          ${rows || '<tr><td colspan="4">Banlı kimse yok.</td></tr>'}
        </table>
      </div>`)
    );
  } catch (err) {
    console.error('Panel hatası:', err.message);
    res.status(500).send(page(`<div class="err">Hata: ${esc(err.message)}</div>`));
  }
});

app.post('/settings', requireAuth, async (req, res) => {
  try {
    const cfg = await loadSettings();
    cfg.autoBan = req.body.autoBan === 'on';

    const channelId = String(req.body.welcomeChannelId || '');
    const channels = await getTextChannels();
    if (channels.some((c) => c.id === channelId)) cfg.welcomeChannelId = channelId;

    const message = String(req.body.welcomeMessage || '').trim().slice(0, 1500);
    if (message) cfg.welcomeMessage = message;

    await saveSettings(cfg);
    flash(req, 'Ayarlar kaydedildi.');
  } catch (err) {
    flash(req, 'Hata: ' + err.message);
  }
  res.redirect('/');
});

app.post('/unban', requireAuth, async (req, res) => {
  try {
    const id = String(req.body.id || '');
    if (!/^\d{5,25}$/.test(id)) throw new Error('Geçersiz ID');
    await discord('DELETE', `/guilds/${GUILD_ID}/bans/${id}`, 'Panelden ban kaldırıldı');
    flash(req, 'Ban kaldırıldı.');
  } catch (err) {
    flash(req, 'Hata: ' + err.message);
  }
  res.redirect('/');
});

const port = process.env.PORT || 3000;
const host = process.env.RENDER ? '0.0.0.0' : '127.0.0.1';
app.listen(port, host, () => console.log(`Panel hazır: http://localhost:${port}`));