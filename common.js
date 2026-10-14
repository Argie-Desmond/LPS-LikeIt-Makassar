/* Shared helpers for all pages */
const CFG = window.APP_CONFIG || {};

async function api(payload) {
  if (!CFG.API_URL || CFG.API_URL.startsWith('PASTE')) {
    throw new Error('API_URL is not set. Edit config.js first.');
  }
  // text/plain avoids a CORS preflight, which Apps Script does not answer.
  const ctrl = ('AbortController' in window) ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 30000) : null;
  let res;
  try {
    res = await fetch(CFG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined
    });
  } catch (e) {
    const err = new Error(e && e.name === 'AbortError' ? 'Request timed out' : 'Failed to fetch');
    err.network = true; throw err;
  } finally { if (timer) clearTimeout(timer); }
  let data;
  try { data = await res.json(); }
  catch (e) {   // Google returns an HTML page when it is overloaded (too many simultaneous requests)
    const err = new Error('Server returned an unexpected response. Check the Web app deployment.');
    err.network = true; throw err;
  }
  if (!data.ok) { const err = new Error(data.error || 'Request failed'); err.busy = !!data.busy; err.code = data.code || ''; throw err; }
  return data;
}

/* Retries when the server is busy or the connection drops, with growing waits.
   opts.tries     – total attempts (default 5)
   opts.busyOnly  – retry only when the server explicitly said "busy" (nothing was written),
                    used for check-in/out so a dropped reply never causes a double action
   opts.onRetry   – callback(attemptNumber) to update the UI */
async function apiRetry(payload, opts = {}) {
  const tries = opts.tries || 5, waits = [1500, 3000, 5000, 8000, 10000];
  for (let i = 0; ; i++) {
    try { const r = await api(payload); r.attempts = i + 1; return r; }
    catch (e) {
      const retryable = e.busy || (!opts.busyOnly && e.network);
      if (i >= tries - 1 || !retryable) throw e;
      if (opts.onRetry) opts.onRetry(i + 1);
      await new Promise(r => setTimeout(r, waits[Math.min(i, waits.length - 1)] + Math.random() * 1000));
    }
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/* What goes inside the QR code */
function qrPayload(r) {
  return JSON.stringify({ id: r.id, name: r.name, nim: r.nim, major: r.major, phone: r.phone, att: r.attendance });
}

function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }

/* Fill event name everywhere */
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-event-name]').forEach(el => el.textContent = CFG.EVENT_NAME || 'Event');
  if (CFG.EVENT_NAME) document.title = document.title.replace('Event', CFG.EVENT_NAME);
});

/* Admin key gate for scanner + dashboard */
function requireAdmin(onReady) {
  const saved = load('adminKey');
  const tryKey = async (key) => {
    await api({ action: 'ping', key });
    store('adminKey', key);
    onReady(key);
  };
  const showGate = (msg) => {
    const gate = document.createElement('div');
    gate.className = 'gate';
    gate.innerHTML = `
      <form class="card gate-card">
        <h2>Staff access</h2>
        <p class="muted">Enter the admin key set in Code.gs.</p>
        <input type="password" name="key" placeholder="Admin key" autocomplete="current-password" required>
        <p class="error">${esc(msg || '')}</p>
        <button class="btn primary" type="submit">Unlock</button>
      </form>`;
    document.body.appendChild(gate);
    const form = gate.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button');
      btn.disabled = true; btn.textContent = 'Checking…';
      try { await tryKey(form.key.value.trim()); gate.remove(); }
      catch (err) { form.querySelector('.error').textContent = err.message; btn.disabled = false; btn.textContent = 'Unlock'; }
    });
    form.key.focus();
  };
  if (saved) tryKey(saved).catch(err => { store('adminKey', null); showGate(err.message); });
  else showGate();
}

function logoutAdmin() { store('adminKey', null); location.reload(); }

/* ---- QR helpers (need qrcode.min.js loaded on the page) ---- */
function makeQR(el, record, size) {
  el.innerHTML = '';
  new QRCode(el, { text: qrPayload(record), width: size || 240, height: size || 240,
    correctLevel: QRCode.CorrectLevel.M });
}

/* Builds a branded PNG ticket (logo + QR + details) and downloads it */
let _logoImg = null;
function loadLogo() {
  if (_logoImg) return Promise.resolve(_logoImg);
  return new Promise(res => {
    const im = new Image();
    im.onload = () => { _logoImg = im; res(im); };
    im.onerror = () => res(null);
    im.src = 'assets/logo.png';
  });
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
async function downloadTicket(record, qrEl) {
  const qrCanvas = qrEl.querySelector('canvas');
  const logo = await loadLogo();
  try { await document.fonts.ready; } catch (e) {}
  const W = 600, H = 860, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const head = '"Fredoka", "Nunito", system-ui, sans-serif', body = '"Nunito", system-ui, sans-serif';
  // background
  g.fillStyle = '#fcf9ee'; g.fillRect(0, 0, W, H);
  // brand stripe
  [['#fbaa2b', 0], ['#f05a28', .25], ['#e2402a', .5], ['#003055', .75]].forEach(([col, x]) => { g.fillStyle = col; g.fillRect(W * x, 0, W / 4, 14); });
  // logo
  let y = 40;
  if (logo) { const lw = 400, lh = lw * logo.height / logo.width; g.drawImage(logo, (W - lw) / 2, y, lw, lh); y += lh + 16; }
  y += 10;
  // QR card
  const qs = 300, box = qs + 36;
  g.fillStyle = '#fff'; g.strokeStyle = '#fbaa2b'; g.lineWidth = 5;
  roundRect(g, (W - box) / 2, y, box, box, 22); g.fill(); g.stroke();
  g.imageSmoothingEnabled = false;
  g.drawImage(qrCanvas, (W - qs) / 2, y + 18, qs, qs);
  g.imageSmoothingEnabled = true;
  y += box + 40;
  g.textAlign = 'center'; g.fillStyle = '#f05a28'; g.font = `700 28px ${head}`; g.fillText(record.id, W / 2, y); y += 36;
  // details
  const lines = [['Nama', record.name], ['NIM', record.nim], ['Prodi', record.major], ['No. HP', record.phone]];
  lines.forEach(([k, v]) => {
    g.textAlign = 'left';
    g.fillStyle = '#7b6f63'; g.font = `600 17px ${body}`; g.fillText(k, 110, y);
    g.fillStyle = '#10263f'; g.font = `800 18px ${body}`;
    let t = String(v); while (g.measureText(t).width > 300 && t.length > 3) t = t.slice(0, -2);
    if (t !== String(v)) t += '…';
    g.fillText(t, 210, y); y += 32;
  });
  // footer band
  const grd = g.createLinearGradient(0, H - 64, 0, H); grd.addColorStop(0, '#f8961e'); grd.addColorStop(1, '#f05a28');
  g.fillStyle = grd; g.fillRect(0, H - 64, W, 64);
  g.textAlign = 'center'; g.fillStyle = '#fff'; g.font = `600 18px ${head}`;
  g.fillText('Tunjukkan QR code & KTM di meja registrasi', W / 2, H - 25);
  const a = document.createElement('a');
  a.download = `ticket-${record.id}.png`;
  a.href = c.toDataURL('image/png');
  a.click();
}
