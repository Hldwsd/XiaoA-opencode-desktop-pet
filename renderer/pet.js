'use strict';

const img = document.getElementById('pet');

// 每个状态有各自的节奏与姿态；所有分量都用 phase 的整数倍正弦，
// 因此在主位移过零点（phase = kπ）时各分量恰好回到中性位，切换动作无缝连贯。
const MODES = {
  idle:     { axis: 'y', period: 3200, amp: 9,  sub: 2.5, rot: 3,  scale: 0.025 },
  thinking: { axis: 'x', period: 2900, amp: 9,  sub: 2.5, rot: 4,  scale: 0.02  },
  working:  { axis: 'y', period: 1500, amp: 7,  sub: 3.5, rot: 5,  scale: 0.035 },
};

// 性能优化：源图多为 2048x2048，显示仅约 256px。
// 加载时降采样到 2 倍显示尺寸（512px）保持清晰，同时大幅减少解码/内存/合成开销。
const MAX_PET = 512;
const downscaleCache = new Map();
const RASTER = /\.(png|jpe?g|webp)$/i;

function fileUrl(p) {
  return encodeURI('file:///' + String(p).replace(/\\/g, '/'));
}

function prepareImage(p) {
  if (!p) return Promise.resolve(null);
  if (downscaleCache.has(p)) return Promise.resolve(downscaleCache.get(p));
  if (!RASTER.test(p)) {
    // SVG 等矢量图直接使用文件 URL，缩放零成本
    const url = fileUrl(p);
    downscaleCache.set(p, url);
    return Promise.resolve(url);
  }
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const scale = Math.min(1, MAX_PET / im.naturalWidth, MAX_PET / im.naturalHeight);
      if (scale >= 1 || im.naturalWidth <= 0 || im.naturalHeight <= 0) {
        const u = fileUrl(p);
        downscaleCache.set(p, u);
        resolve(u);
        return;
      }
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(im.naturalWidth * scale));
      c.height = Math.max(1, Math.round(im.naturalHeight * scale));
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/png');
      downscaleCache.set(p, url);
      resolve(url);
    };
    im.onerror = () => {
      const u = fileUrl(p);
      downscaleCache.set(p, u);
      resolve(u);
    };
    im.src = fileUrl(p);
  });
}

let charFiles = null;
let mode = MODES.idle;
let pendingMode = null;
let phase = 0;
let prevSin = 0;
let lastT = null;
let status = 'idle';
let ampK = 1;
let ampTarget = 1;
let shakeStart = -1e9;
let frame = 0;
const SHAKE_DUR = 600;
const SHAKE_AMP = 10;

function fileForStatus(s) {
  const key = s === 'thinking' ? 'thinking' : (s === 'working' ? 'working' : 'idle');
  return charFiles ? charFiles[key] : null;
}

function applyImage() {
  const f = fileForStatus(status);
  if (!f) return;
  prepareImage(f).then((url) => {
    if (url && img.src !== url) img.src = url;
  });
}

function setStatus(s) {
  s = s || 'idle';
  status = s;
  applyImage();
  const m = MODES[s] || MODES.idle;
  if (m !== mode) pendingMode = m;
}

function wander(dt) {
  ampK += (ampTarget - ampK) * Math.min(1, dt / 2200);
  if (Math.random() < dt / 1600) ampTarget = 0.7 + Math.random() * 0.55;
}

function tick(t) {
  if (lastT === null) lastT = t;
  const dt = Math.min(50, t - lastT);
  lastT = t;
  // 性能优化：每 3 帧（约 20fps）更新一次位移，动画平滑且大幅降低透明窗口合成开销
  if ((frame++ % 3) !== 0) { requestAnimationFrame(tick); return; }
  phase = (phase + 2 * Math.PI * dt / mode.period) % (2 * Math.PI);
  const sin = Math.sin(phase);
  if (pendingMode && ((prevSin >= 0 && sin < 0) || (prevSin <= 0 && sin > 0))) {
    mode = pendingMode;
    pendingMode = null;
  }
  prevSin = sin;
  wander(dt);

  const A = mode.amp * ampK;
  const sA = mode.sub * ampK;
  const yOff = mode.axis === 'y' ? A * sin : sA * sin;
  const xOff = mode.axis === 'x' ? A * sin : sA * sin;
  const rot = mode.rot * Math.sin(phase * 2);
  const scale = 1 + mode.scale * Math.sin(phase * 2);

  let shakeX = 0;
  const sElapsed = t - shakeStart;
  if (sElapsed < SHAKE_DUR) {
    const k = sElapsed / SHAKE_DUR;
    shakeX = Math.sin(k * Math.PI * 10) * SHAKE_AMP * (1 - k);
  }

  img.style.transform =
    'translateX(' + (xOff + shakeX).toFixed(2) + 'px)' +
    'translateY(' + yOff.toFixed(2) + 'px)' +
    'rotate(' + rot.toFixed(2) + 'deg)' +
    'scale(' + scale.toFixed(3) + ')';
  requestAnimationFrame(tick);
}

window.petAPI.onPetChanged((char) => {
  if (!char) return;
  charFiles = char.files || null;
  applyImage();
});

window.petAPI.onPermissionShake(() => {
  shakeStart = performance.now();
});

window.petAPI.onProgress((p) => {
  if (p && p.status) setStatus(p.status);
});

window.addEventListener('dblclick', () => window.petAPI.togglePopup());
window.addEventListener('contextmenu', (e) => e.preventDefault());

window.petAPI.getCurrentCharacter().then((char) => {
  if (char) charFiles = char.files || null;
  window.petAPI.getProgress().then((p) => {
    setStatus(p && p.status ? p.status : 'idle');
  });
  applyImage();
});

requestAnimationFrame(tick);
