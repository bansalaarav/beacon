// Small helpers shared by every page. No framework, no build step.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function api(path, { method = 'GET', body, token, organizerKey, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (organizerKey) headers['x-organizer-key'] = organizerKey;
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

export function avatar(p, { size = '', showOnline = false, style = '' } = {}) {
  const inner = p.photo ? `<img src="${esc(p.photo)}" alt="">` : esc(p.emoji || '👋');
  const dot = showOnline && p.status === 'here' ? `<span class="dot ${p.online ? '' : 'off'}"></span>` : '';
  return `<div class="avatar ${size}" style="--c:${esc(p.color || '#5b4cf0')};${style}">${inner}${dot}</div>`;
}

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function toast(html, { action, onAction, timeout = 5000 } = {}) {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.append(box); }
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div style="flex:1">${html}</div>${action ? `<button>${esc(action)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { onAction?.(); el.remove(); };
  box.prepend(el);
  setTimeout(() => el.remove(), timeout);
  if (navigator.vibrate && navigator.userActivation?.hasBeenActive) navigator.vibrate(40);
}

// Resize a picked/captured photo client-side so profiles stay small (~15 KB).
export function resizeImage(file, max = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const side = Math.min(img.width, img.height);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = Math.round(side * scale);
      // centre-crop to a square
      canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

export const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* private mode */ } },
};

// Chip-style tag input with one-tap suggestions.
export function chipInput(root, { value = [], suggestions = [], placeholder = 'Type and press Enter' } = {}) {
  let tags = [...value];
  root.innerHTML = `<div class="chip-input"><input placeholder="${esc(placeholder)}"></div><div class="suggest"></div>`;
  const box = root.querySelector('.chip-input');
  const input = root.querySelector('input');
  const sug = root.querySelector('.suggest');

  const add = t => {
    t = t.trim().toLowerCase().replace(/^#/, '');
    if (t && !tags.includes(t) && tags.length < 15) tags.push(t);
    render();
  };
  const render = () => {
    box.querySelectorAll('.tag').forEach(n => n.remove());
    for (const t of tags) {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.textContent = `${t} ✕`;
      chip.onclick = () => { tags = tags.filter(x => x !== t); render(); };
      box.insertBefore(chip, input);
    }
    sug.innerHTML = '';
    for (const s of suggestions.filter(s => !tags.includes(s)).slice(0, 10)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `+ ${s}`;
      b.onclick = () => add(s);
      sug.append(b);
    }
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(input.value); input.value = ''; }
    if (e.key === 'Backspace' && !input.value && tags.length) { tags.pop(); render(); }
  });
  input.addEventListener('blur', () => { if (input.value) { add(input.value); input.value = ''; } });
  box.onclick = () => input.focus();
  render();
  return { get value() { if (input.value) { add(input.value); input.value = ''; } return tags; } };
}

export const SUGGESTED = {
  interests: ['startups', 'machine learning', 'llms', 'climate tech', 'design', 'fintech', 'web3', 'data', 'frontend', 'backend', 'hardware', 'open source', 'healthtech', 'edtech', 'marketing', 'product strategy', 'robotics', 'security', 'community', 'hackathons'],
  lookingFor: ['co-founder', 'mentorship', 'jobs', 'internships', 'fundraising', 'design', 'engineering', 'side projects', 'research collaboration', 'go-to-market', 'deal flow', 'speaking'],
  offering: ['mentorship', 'fundraising', 'jobs', 'career advice', 'design', 'engineering', 'frontend', 'backend', 'machine learning', 'marketing', 'user research', 'product strategy', 'public speaking'],
};
