'use strict';

const { app, BrowserWindow, Tray, dialog, ipcMain, nativeImage, screen, clipboard } = require('electron');
const { exec, spawn } = require('child_process');
const { Worker } = require('worker_threads');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 禁用硬件加速：Windows 下透明窗口的 DWM 合成闪黑/闪透明的可靠修复
app.disableHardwareAcceleration();

const PET_W = 320;
const PET_H = 320;
const POPUP_W = 380;
const POPUP_H = 264;
const POLL_INTERVAL = 6000;
const SESSION_LIST_N = 200;

const petsDir = path.join(app.getPath('userData'), 'pets');
const bundledPetsDir = path.join(__dirname, 'pets');
const configPath = path.join(app.getPath('userData'), 'pet-config.json');
const trayIconPath = path.join(__dirname, 'assets', 'tray.png');
const iconPath = path.join(__dirname, 'assets', 'icon.ico');
const defaultCharDir = path.join(__dirname, 'assets', 'characters', 'default');

let petWindow = null;
let popupWindow = null;
let menuWindow = null;
let createWindow = null;
let permissionWindow = null;
let activePerm = null;
let tray = null;
let progressTimer = null;
let polling = false;

let menuActionSeq = 0;
const menuActionMap = new Map();
const menuDelMap = new Map();
let lastMenuPos = { x: 0, y: 0 };

const state = {
  currentChar: null,
  sessionId: null,
  lastUpdated: 0,
  exportCache: null,
  progress: null,
  popupVisible: true,
  following: true,
  pinnedId: null,
  sessions: [],
  petScale: 1,
  popupScale: 1,
  popupOpacity: 100,
  popupAlwaysTop: true,
  petClickThrough: false,
  popupCachedW: POPUP_W,
  popupCachedH: POPUP_H,
  opencodeServer: null,
  currentPermKey: null,
  pendingPerm: null,
  currentPerm: null,
};
const permMap = new Map();
const progressCache = new Map();
let sseRequest = null;
let probeTimer = null;
let tuiProc = null;

// ---------------- 会话进度解析子线程 ----------------
// 大会话导出 JSON 的 JSON.parse + parseExport 较重，放到 worker 线程执行，
// 避免切换任务时阻塞主进程（否则界面会短暂卡顿）。

let parseWorker = null;
const parsePending = new Map();
let parseSeq = 0;

function getParseWorker() {
  if (!parseWorker) {
    try {
      parseWorker = new Worker(fs.readFileSync(path.join(__dirname, 'progress-worker.js'), 'utf8'), { eval: true });
    } catch (e) {
      console.error('create parse worker', e);
      parseWorker = null;
      return null;
    }
    parseWorker.on('message', (m) => {
      const cb = parsePending.get(m.id);
      if (cb) { parsePending.delete(m.id); cb(null, m.progress); }
    });
    parseWorker.on('error', (e) => {
      console.error('parse worker error', e);
      const cbs = Array.from(parsePending.values());
      parsePending.clear();
      for (const cb of cbs) cb(e || new Error('worker error'));
    });
    parseWorker.on('exit', () => { parseWorker = null; });
  }
  return parseWorker;
}

function parseExportAsync(raw) {
  return new Promise((resolve, reject) => {
    const id = ++parseSeq;
    const timer = setTimeout(() => {
      parsePending.delete(id);
      reject(new Error('解析超时'));
    }, 10000);
    parsePending.set(id, (err, progress) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(progress);
    });
    const w = getParseWorker();
    if (!w) {
      parsePending.delete(id);
      clearTimeout(timer);
      reject(new Error('无法创建解析线程'));
      return;
    }
    w.postMessage({ id, raw });
  });
}

function readConfig() {
  try {
    let raw = fs.readFileSync(configPath, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch { return {}; }
}
function writeConfig(cfg) {
  try {
    const merged = Object.assign({}, readConfig(), cfg);
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
  } catch (e) { console.error('writeConfig', e); }
}

function charFiles(dir) {
  const files = {};
  for (const key of ['idle', 'thinking', 'working']) {
    for (const ext of ['svg', 'png']) {
      const p = path.join(dir, key + '.' + ext);
      if (fs.existsSync(p)) { files[key] = p; break; }
    }
  }
  return files;
}

function listCharacters() {
  const chars = [{ name: '小A', dir: defaultCharDir, builtin: true, files: charFiles(defaultCharDir) }];
  try {
    for (const entry of fs.readdirSync(petsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(petsDir, entry.name);
      const files = charFiles(dir);
      if (files.idle || files.thinking || files.working) {
        chars.push({ name: entry.name, dir, builtin: false, files });
      }
    }
  } catch { }
  return chars;
}

function sanitizeCharName(name) {
  return String(name || '').replace(/[^\w\u4e00-\u9fa5]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || '宠物';
}

function migrateLoosePets() {
  try {
    const loose = fs.readdirSync(petsDir).filter((f) => /\.(svg|png)$/i.test(f));
    if (!loose.length) return;
    const src = path.join(petsDir, loose[0]);
    const name = sanitizeCharName(path.basename(src, path.extname(src)));
    const dir = path.join(petsDir, name);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(src).toLowerCase();
      for (const key of ['idle', 'thinking', 'working']) {
        fs.copyFileSync(src, path.join(dir, key + ext));
      }
    }
    fs.rmSync(src, { force: true });
  } catch { }
}

function migrateBundledPets() {
  try {
    if (!fs.existsSync(bundledPetsDir)) return;
    fs.mkdirSync(petsDir, { recursive: true });
    for (const entry of fs.readdirSync(bundledPetsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = path.join(bundledPetsDir, entry.name);
      const dst = path.join(petsDir, entry.name);
      if (!fs.existsSync(dst)) {
        fs.cpSync(src, dst, { recursive: true });
      }
    }
  } catch (e) {
    console.error('migrateBundledPets', e);
  }
}

function setCharacter(name) {
  const c = listCharacters().find((x) => x.name === name);
  if (!c) return false;
  state.currentChar = { name: c.name, dir: c.dir, builtin: c.builtin, files: c.files };
  writeConfig({ ...readConfig(), currentChar: c.name });
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-changed', { name: state.currentChar.name, files: state.currentChar.files });
  }
  return true;
}

async function deleteCharacter(name) {
  const c = listCharacters().find((x) => x.name === name);
  if (!c || c.builtin) return false;
  const r = await dialog.showMessageBox(petWindow, {
    type: 'warning',
    buttons: ['删除', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: '删除桌宠',
    message: '确定删除桌宠「' + c.name + '」吗？',
    detail: c.dir,
  });
  if (r.response !== 0) return false;
  try { fs.rmSync(c.dir, { recursive: true, force: true }); } catch (e) { console.error('deleteCharacter', e); return false; }
  if (state.currentChar && state.currentChar.name === name) setCharacter('小A');
  return true;
}

function createCharacter({ name, work, think, idle }) {
  name = String(name || '').trim();
  if (!name) return { ok: false, error: '请输入桌宠名称' };
  if (!/^[\w\u4e00-\u9fa5\- ]{1,40}$/.test(name)) return { ok: false, error: '名称只能包含中文、字母、数字、下划线、短横线和空格' };
  const dir = path.join(petsDir, name);
  if (fs.existsSync(dir)) return { ok: false, error: '已存在同名桌宠「' + name + '」' };
  const map = { idle, thinking: think, working: work };
  for (const key of ['idle', 'thinking', 'working']) {
    const src = map[key];
    if (!src || !fs.existsSync(src)) { return { ok: false, error: '请为每个状态选择图片' }; }
    const ext = path.extname(src).toLowerCase();
    if (!['.svg', '.png'].includes(ext)) return { ok: false, error: '仅支持 SVG/PNG 图片' };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const key of ['idle', 'thinking', 'working']) {
      fs.copyFileSync(map[key], path.join(dir, key + path.extname(map[key]).toLowerCase()));
    }
  } catch (e) {
    console.error('createCharacter', e);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
    return { ok: false, error: '创建失败：' + (e.message || '文件复制出错') };
  }
  setCharacter(name);
  return { ok: true };
}

function runCmd(cmd, timeout = 20000) {
  return new Promise((resolve) => {
    exec(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// ---------------- OpenCode 进度 ----------------

async function fetchSessionList() {
  const { err, stdout } = await runCmd(`opencode session list --format json -n ${SESSION_LIST_N}`);
  if (err) throw new Error('无法获取会话列表：' + (err.message || 'opencode 未安装或不在 PATH'));
  const arr = JSON.parse(stdout);
  return Array.isArray(arr) ? arr : [];
}

async function fetchExport(id) {
  const { err, stdout } = await runCmd(`opencode export ${id}`);
  if (err) throw new Error('导出会话失败：' + (err.message || ''));
  return stdout;
}

const TOOL_LABELS = {
  bash: '执行命令',
  edit: '写入文件',
  write: '写入文件',
  read: '读取文件',
  glob: '查找文件',
  webfetch: '访问网页',
  websearch: '搜索内容',
  task: '调用子任务',
  external_directory: '访问项目外部目录',
};

async function fetchPendingPerm() {
  try {
    const perms = await fetchPendingPermissions();
    return perms && perms.length ? perms[0] : null;
  } catch {
    return null;
  }
}

function emptyProgress(title, error) {
  return {
    sessionId: null, title: title || '暂无会话', status: error ? 'error' : 'idle', idle: true,
    currentTool: null, latestText: '', latestReasoning: '',
    tools: { done: 0, total: 0, running: 0 }, steps: 0, todos: { total: 0, done: 0 },
    updatedAgoMs: 0, error: error || null,
  };
}

async function pollProgress() {
  if (polling) return;
  polling = true;
  try {
    const sessions = await fetchSessionList();
    state.sessions = sessions.map((s) => ({ id: s.id, title: s.title, updated: s.updated }));
    broadcastSessions();

    const target = state.following
      ? sessions[0]
      : (sessions.find((s) => s.id === state.pinnedId) || sessions[0]);
    if (!target) {
      state.sessionId = null;
      state.lastUpdated = 0;
      state.exportCache = null;
      state.progress = emptyProgress('暂无会话');
      state.pendingPerm = await fetchPendingPerm();
      broadcastProgress();
      handlePermissionChange();
      return;
    }

    state.sessionId = target.id;
    state.lastUpdated = target.updated;

    const cached = progressCache.get(target.id);
    if (cached && cached.updated === target.updated) {
      state.progress = cached.progress;
    } else {
      // 切换任务时先立即展示加载占位，避免界面停留在旧任务上造成卡顿感；
      // 同一任务更新中则保留旧进度，等待新数据到达后平滑刷新。
      const isSwitch = !state.progress || state.progress.sessionId !== target.id;
      if (isSwitch) {
        state.progress = emptyProgress(target.title || '加载中…');
        state.progress.status = 'loading';
        broadcastProgress();
      }
      const raw = await fetchExport(target.id);
      const parsed = await parseExportAsync(raw);
      state.progress = parsed;
      progressCache.set(target.id, { updated: target.updated, progress: parsed });
      if (progressCache.size > 100) {
        const firstKey = progressCache.keys().next().value;
        if (firstKey) progressCache.delete(firstKey);
      }
    }
    broadcastProgress();
    state.pendingPerm = await fetchPendingPerm();
    handlePermissionChange();
  } catch (e) {
    state.progress = emptyProgress('无法连接 OpenCode', String(e.message || e).slice(0, 200));
    broadcastProgress();
  } finally {
    polling = false;
  }
}

function broadcastSessions() {
  const payload = { sessions: state.sessions, following: state.following, pinnedId: state.pinnedId };
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send('sessions-updated', payload);
  }
}

function selectSession(idOrLatest) {
  if (idOrLatest === 'latest' || idOrLatest == null) {
    state.following = true;
    state.pinnedId = null;
  } else {
    state.following = false;
    state.pinnedId = idOrLatest;
  }
  state.sessionId = null;
  state.lastUpdated = 0;
  state.exportCache = null;
  state.progress = emptyProgress('切换中…');
  state.progress.status = 'loading';
  broadcastProgress();
  writeConfig({ ...readConfig(), following: state.following, pinnedId: state.pinnedId });
  broadcastSessions();
  pollProgress();
}

function broadcastProgress() {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send('progress-updated', state.progress);
  }
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('progress-updated', state.progress);
  }
}

// ---------------- 权限请求 ----------------

function describePermission(p) {
  const res = Array.isArray(p.patterns) && p.patterns.length ? String(p.patterns[0]).trim() : '';
  const action = p.permission || p.action || '';
  const label = TOOL_LABELS[action] || ('调用工具 ' + action);
  return label + (res ? '：' + String(res).slice(0, 200) : '');
}

async function fetchPendingPermissions() {
  const server = state.opencodeServer;
  if (!server) return [];
  const headers = Object.assign({}, authHeaders(), { 'Content-Type': 'application/json' });
  try {
    const dirs = new Set();
    const res = await fetch(server + '/session', { headers });
    if (res.ok) {
      const arr = await res.json();
      if (Array.isArray(arr)) {
        for (const s of arr) {
          if (s && s.directory) dirs.add(String(s.directory));
        }
      }
    }
    const queries = [];
    if (!dirs.size) {
      queries.push(server + '/permission');
    } else {
      for (const d of dirs) queries.push(server + '/permission?directory=' + encodeURIComponent(d));
    }
    const groups = await Promise.all(queries.map(async (q) => {
      const dir = q.indexOf('directory=') >= 0 ? decodeURIComponent(q.slice(q.indexOf('directory=') + 10)) : null;
      try {
        const r = await fetch(q, { headers });
        if (!r.ok) return [];
        const arr = await r.json();
        if (!Array.isArray(arr)) return [];
        const out = [];
        for (const p of arr) {
          if (p && typeof p === 'object') {
            if (dir && !p._directory) p._directory = dir;
            out.push(p);
          }
        }
        return out;
      } catch { return []; }
    }));
    const found = groups.flat();
    const seen = new Set();
    return found.filter((p) => {
      if (!p || !p.id || seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  } catch {
    return [];
  }
}

function handlePermissionChange() {
  const prog = state.progress || {};
  // 仅以 /permission API 的 pending 权限为准（权威来源，按目录轮询已可靠）；
  // 不采用 "running 且无输出" 的启发式兜底，避免把长时间运行的命令误判为权限阻塞
  const perm = state.pendingPerm;
  let key = null;
  if (perm) {
    key = (perm.sessionID || prog.sessionId) + '|' + (perm.id || (perm.tool && perm.tool.callID) || '');
  }
  if (key && key !== state.currentPermKey) {
    state.currentPermKey = key;
    state.currentPerm = {
      id: perm.id,
      sessionId: perm.sessionID,
      directory: perm._directory || (prog && prog.directory) || null,
      server: state.opencodeServer,
    };
    showPermissionWindow({
      sessionId: perm.sessionID,
      directory: perm._directory || (prog && prog.directory),
      permission: {
        tool: perm.tool ? (perm.tool.callID ? '工具调用' : '') : '',
        action: describePermission(perm),
        callID: perm.tool ? perm.tool.callID : null,
        id: perm.id,
      },
      server: state.opencodeServer,
    });
    shakePet();
  } else if (!key && state.currentPermKey) {
    state.currentPermKey = null;
    state.currentPerm = null;
    closePermissionWindow();
  }
}

function shakePet() {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('permission-shake');
  }
}

function createPermissionWindow() {
  permissionWindow = new BrowserWindow({
    width: 380,
    height: 210,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  permissionWindow.setAlwaysOnTop(true, 'screen-saver');
  permissionWindow.loadFile(path.join(__dirname, 'renderer', 'permission.html'));
  permissionWindow.on('closed', () => { permissionWindow = null; });
}

function showPermissionWindow(progress) {
  if (!permissionWindow || permissionWindow.isDestroyed()) createPermissionWindow();
  const bounds = petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : screen.getPrimaryDisplay().workArea;
  const { width: w, height: h } = permissionWindow.getBounds();
  const x = Math.round(bounds.x + bounds.width / 2 - w / 2);
  const y = Math.max(bounds.y - h - 8, 0);
  permissionWindow.setPosition(x, y);
  permissionWindow.showInactive();
  const payload = {
    sessionId: progress.sessionId,
    directory: progress.directory,
    permission: progress.permission,
    server: state.opencodeServer ? state.opencodeServer : null,
  };
  const send = () => {
    if (permissionWindow && !permissionWindow.isDestroyed()) permissionWindow.webContents.send('permission-show', payload);
  };
  if (permissionWindow.webContents.isLoadingMainFrame()) {
    permissionWindow.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

function closePermissionWindow() {
  if (permissionWindow && !permissionWindow.isDestroyed()) permissionWindow.close();
}

function authHeaders() {
  const cfg = readConfig();
  const pass = cfg.opencodePassword || process.env.OPENCODE_SERVER_PASSWORD;
  if (!pass) return undefined;
  const user = cfg.opencodeUsername || process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  return { Authorization: 'Basic ' + Buffer.from(user + ':' + pass).toString('base64') };
}

// ---------------- 桌面版服务器密码自动恢复 ----------------
// 桌面版 OpenCode 每次启动会为内嵌服务器生成新的随机密码（UUID），
// 且不写入磁盘。这里通过读取服务器进程内存扫描 UUID 并逐一探测，
// 自动找到当前有效密码，保证桌宠在桌面版重启后也能自动连上。

const MEMSCAN_PS1 = [
  'param([Parameter(Mandatory=$true)][int]$ProcessId,[Parameter(Mandatory=$true)][string]$Base,[string]$Username="opencode")',
  '$ErrorActionPreference="Stop"',
  '$code=@\'',
  'using System;',
  'using System.Collections.Generic;',
  'using System.Net;',
  'using System.Text;',
  'using System.Text.RegularExpressions;',
  'using System.Runtime.InteropServices;',
  'public class PetMemScan {',
  '  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);',
  '  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, UIntPtr size, out UIntPtr read);',
  '  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);',
  '  [DllImport("kernel32.dll")] public static extern UIntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MBI mbi, UIntPtr len);',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct MBI { public IntPtr BaseAddress; public IntPtr AllocationBase; public uint AllocationProtect; public IntPtr RegionSize; public uint State; public uint Protect; public uint Type; }',
  '  static bool Test(string baseUrl, string user, string pw) {',
  '    try {',
  '      var req = (HttpWebRequest)WebRequest.Create(baseUrl.TrimEnd(\'/\') + "/global/health");',
  '      req.Method = "GET"; req.Timeout = 2000;',
  '      string auth = Convert.ToBase64String(Encoding.UTF8.GetBytes(user + ":" + pw));',
  '      req.Headers["Authorization"] = "Basic " + auth;',
  '      using (var resp = (HttpWebResponse)req.GetResponse()) { return (int)resp.StatusCode == 200; }',
  '    } catch (WebException we) {',
  '      var r = we.Response as HttpWebResponse;',
  '      if (r != null && (int)r.StatusCode == 200) return true;',
  '      return false;',
  '    } catch { return false; }',
  '  }',
  '  static bool CollectAndTest(Regex rx, HashSet<string> seen, string text, string baseUrl, string username) {',
  '    foreach (Match m in rx.Matches(text)) {',
  '      string v = m.Value.ToLowerInvariant();',
  '      if (!seen.Add(v)) continue;',
  '      if (v == "00000000-0000-0000-0000-000000000000") continue;',
  '      if (Test(baseUrl, username, v)) { Console.WriteLine("FOUND=" + v); return true; }',
  '    }',
  '    return false;',
  '  }',
  '  public static void Find(string baseUrl, uint pid, string username) {',
  '    IntPtr h = OpenProcess(0x0410, false, pid);',
  '    if (h == IntPtr.Zero) return;',
  '    var seen = new HashSet<string>();',
  '    var rx = new Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", RegexOptions.Compiled);',
  '    long addr = 0, total = 0;',
  '    try {',
  '      while (addr < 0x7FFFFFFFFFFF && total < 300000000L) {',
  '        MBI mbi;',
  '        if (VirtualQueryEx(h, (IntPtr)addr, out mbi, (UIntPtr)Marshal.SizeOf(typeof(MBI))) == UIntPtr.Zero) break;',
  '        bool committed = mbi.State == 0x1000;',
  '        bool readable = (mbi.Protect & 0x04) != 0 || (mbi.Protect & 0x02) != 0 || (mbi.Protect & 0x20) != 0 || (mbi.Protect & 0x40) != 0 || (mbi.Protect & 0x08) != 0 || (mbi.Protect & 0x80) != 0;',
  '        long size = (long)mbi.RegionSize;',
  '        if (committed && readable && size > 0 && size < 0x7FFFFFFF) {',
  '          long chunk = 128 * 1024;',
  '          for (long off = 0; off < size; off += chunk) {',
  '            int len = (int)Math.Min(chunk, size - off);',
  '            byte[] buf = new byte[len]; UIntPtr read;',
  '            if (ReadProcessMemory(h, (IntPtr)(addr + off), buf, (UIntPtr)len, out read) && read.ToUInt64() > 0) {',
  '              total += (long)read;',
  '              if (CollectAndTest(rx, seen, Encoding.ASCII.GetString(buf, 0, (int)read), baseUrl, username)) return;',
  '              if (CollectAndTest(rx, seen, Encoding.Unicode.GetString(buf, 0, (int)read), baseUrl, username)) return;',
  '            }',
  '          }',
  '        }',
  '        long next = addr + Math.Max(size, 1);',
  '        if (next <= addr) break;',
  '        addr = next;',
  '      }',
  '    } catch { }',
  '    finally { CloseHandle(h); }',
  '  }',
  '}',
  '\'@',
  'Add-Type -TypeDefinition $code',
  '[PetMemScan]::Find($Base, [uint32]$ProcessId, $Username)'
].join('\n');

function writeMemScanScript() {
  try {
    const p = path.join(app.getPath('userData'), 'petmemscan.ps1');
    fs.writeFileSync(p, MEMSCAN_PS1, 'utf8');
    return p;
  } catch { return null; }
}

let recoveryInFlight = false;
let lastRecoveryAt = 0;

function recoverServerPassword(base, pid) {
  return new Promise((resolve) => {
    if (recoveryInFlight) { resolve(null); return; }
    const now = Date.now();
    if (now - lastRecoveryAt < 30000) { resolve(null); return; }
    recoveryInFlight = true;
    lastRecoveryAt = now;
    const script = writeMemScanScript();
    if (!script) { recoveryInFlight = false; resolve(null); return; }
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProcessId', String(pid), '-Base', base];
    const rcfg = readConfig() || {};
    const user = rcfg.opencodeUsername || process.env.OPENCODE_SERVER_USERNAME || 'opencode';
    args.push('-Username', user);
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      recoveryInFlight = false;
      resolve(val);
    };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, 60000);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.on('close', () => {
      const m = out.match(/FOUND=([0-9a-f-]{36})/i);
      finish(m ? m[1] : null);
    });
    child.on('error', () => finish(null));
  });
}

async function grantPermission(allow) {
  const server = state.opencodeServer;
  if (!server) return { ok: false, error: '未连接 opencode 服务器' };
  const cp = state.currentPerm;
  const permissionID = cp && cp.id;
  if (!permissionID) {
    return { ok: false, error: '未获取到权限 ID（服务器需开启端口并运行 opencode）' };
  }
  const headers = Object.assign({ 'Content-Type': 'application/json' }, authHeaders());
  const body = JSON.stringify({ reply: allow ? 'once' : 'reject' });
  const base = server + '/permission/' + encodeURIComponent(permissionID) + '/reply';
  const dirs = [];
  if (cp && cp.directory) dirs.push(String(cp.directory));
  try {
    const queries = dirs.length ? dirs.map((d) => base + '?directory=' + encodeURIComponent(d)) : [base];
    for (const q of queries) {
      const res = await fetch(q, { method: 'POST', headers, body });
      if (res.ok) {
        state.currentPerm = null;
        return { ok: true };
      }
    }
    return { ok: false, error: '服务器返回 HTTP（未匹配目录）' };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

// ---------------- SSE 权限事件 ----------------

function onPermissionAsked(p, directory) {
  if (!p.sessionID || !p.id) return;
  permMap.set(p.sessionID, p.id);
  if (directory && !p._directory) p._directory = directory;
  state.pendingPerm = Object.assign({}, state.pendingPerm || {}, p);
  handlePermissionChange();
  // 事件驱动先显示，再以 /permission API 权威核对一次，避免 API 尚未同步导致的误判/误关
  setTimeout(async () => {
    try { state.pendingPerm = await fetchPendingPerm(); } catch { return; }
    handlePermissionChange();
  }, 600);
}

function startSse(server) {
  stopSse();
  const url = server + '/global/event';
  const req = http.get(url, { headers: authHeaders() }, (res) => {
    if (res.statusCode !== 200) {
      stopSse();
      return;
    }
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        // 事件流 99% 是与权限无关的 message.part.updated/sync：
        // 先对整个原始事件做廉价 includes 检查，不含 permission 的直接跳过，避免逐行 split 的开销
        if (raw.indexOf('permission') === -1) continue;
        let event = null;
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data || data.indexOf('permission') === -1) continue;
        let msg;
        try { msg = JSON.parse(data); } catch { continue; }
        const ev = msg && msg.payload ? msg.payload : msg;
        const evType = event || ev.type;
        const p = ev.properties;
        if (!p) continue;
        if (evType === 'permission.asked' || evType === 'permission.updated') {
          onPermissionAsked(p, msg.directory);
        } else if (evType === 'permission.replied') {
          const sid = p.sessionID;
          if (sid) permMap.delete(sid);
          if (activePerm && (activePerm.id === p.requestID || activePerm.id === p.id)) {
            activePerm = null;
            state.currentPermKey = null;
            closePermissionWindow();
          }
        }
      }
    });
    res.on('end', () => {
      if (sseRequest === req) { sseRequest = null; }
    });
    res.on('close', () => {
      if (sseRequest === req) { sseRequest = null; }
    });
  });
  req.on('error', () => {
    if (sseRequest === req) sseRequest = null;
  });
  req.on('close', () => {
    if (sseRequest === req) sseRequest = null;
  });
  req.setTimeout(20000, () => req.destroy());
  sseRequest = req;
}

function stopSse() {
  if (sseRequest) {
    try { sseRequest.destroy(); } catch {}
    sseRequest = null;
  }
}

function probeServer(cb) {
  discoverOpenCodeServers((servers, authPorts) => {
    let chosen = servers.length ? servers[0] : null;
    const finish = (recovered) => {
      if (recovered) console.log('[probe] 密码恢复成功, 连接', chosen);
      if (chosen && (chosen !== state.opencodeServer || !sseRequest)) {
        state.opencodeServer = chosen;
        startSse(chosen);
      }
      if (cb) cb(!!chosen);
    };
    // 存在需要认证的服务器（桌面版）且当前没有更优连接时，尝试自动恢复密码
    if (authPorts.length && (!chosen || chosen.endsWith(':4096'))) {
      const next = authPorts.shift();
      recoverServerPassword(next.base, next.pid).then((pw) => {
        if (pw) {
          const cfg = readConfig() || {};
          if (cfg.opencodePassword !== pw) {
            cfg.opencodePassword = pw;
            writeConfig(cfg);
          }
          chosen = next.base;
          finish(true);
        } else {
          finish(false);
        }
      });
    } else {
      finish(false);
    }
  });
}

function ensureServerConnection() {
  // 连接的是桌面版服务器时才做轻量健康检查（1 次 HTTP），避免每 20s 全量发现；
  // 若还挂在 CLI 兜底服务器(4096)，仍需定期全量发现并切换/恢复桌面版密码，
  // 否则桌面版重启后权限弹窗会一直收不到（桌面版权限只走桌面版服务器）。
  if (sseRequest && state.opencodeServer && !state.opencodeServer.endsWith(':4096')) {
    healthOk(state.opencodeServer, (ok) => {
      if (!ok) {
        stopSse();
        probeServer(() => {
          if (!state.opencodeServer) startTuiServer();
        });
      }
    });
  } else {
    probeServer(() => {
      if (!state.opencodeServer) startTuiServer();
    });
  }
}

// ---------------- 自动拉起 opencode 服务器（4096） ----------------

function discoverOpenCodeServers(cb) {
  exec('netstat -ano -p tcp', { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10000, windowsHide: true }, (err, netout) => {
    if (err) { cb([], []); return; }
    const lines = String(netout || '').split(/\r?\n/);
    const byPid = new Map();
    for (const line of lines) {
      const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/);
      if (m) {
        const addr = m[1], pid = m[3];
        if (addr === '127.0.0.1' || addr === '0.0.0.0' || addr === '[::]' || addr === '[::1]' || addr === '*') {
          if (!byPid.has(pid)) byPid.set(pid, []);
          byPid.get(pid).push(Number(m[2]));
        }
      }
    }
    if (!byPid.size) { cb([], []); return; }
    exec('tasklist /FO CSV /NH', { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10000, windowsHide: true }, (err2, taskout) => {
      if (err2) { cb([], []); return; }
      const opencodePids = new Set();
      for (const line of String(taskout || '').split(/\r?\n/)) {
        const m = line.trim().match(/^"([^"]+)"\s*,\s*"(\d+)"/);
        if (m && /opencode/i.test(m[1])) opencodePids.add(m[2]);
      }
      if (!opencodePids.size) { cb([], []); return; }
      const portPids = new Map();
      for (const pid of opencodePids) {
        const list = byPid.get(pid);
        if (list) for (const port of list) if (!portPids.has(port)) portPids.set(port, pid);
      }
      const unique = Array.from(portPids.keys());
      if (!unique.length) { cb([], []); return; }
      const results = [];
      const authPorts = [];
      let pending = unique.length;
      const done = () => {
        pending -= 1;
        if (pending <= 0) {
          results.sort((a, b) => {
            const a4096 = a.base.endsWith(':4096');
            const b4096 = b.base.endsWith(':4096');
            if (a4096 !== b4096) return a4096 ? 1 : -1;
            return 0;
          });
          cb(results.map((r) => r.base), authPorts);
        }
      };
      for (const port of unique) {
        const base = 'http://127.0.0.1:' + port;
        const req = http.get(base + '/global/health', { headers: authHeaders() }, (res) => {
          if (res.statusCode === 200) results.push({ base });
          else if (res.statusCode === 401) authPorts.push({ base, pid: portPids.get(port) });
          res.resume();
          done();
        });
        req.on('error', () => done());
        req.setTimeout(2500, () => { try { req.destroy(); } catch {} done(); });
      }
    });
  });
}

function resolveOpenCodeExe() {
  const candidates = [
    process.env.OPENCODE_EXE,
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'opencode.cmd'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (c.includes(path.sep) || c.includes('/')) {
      if (fs.existsSync(c)) return c;
    }
  }
  return 'opencode';
}

function healthOk(base, cb) {
  const req = http.get(base + '/global/health', { headers: authHeaders() }, (res) => {
    res.resume();
    cb(res.statusCode === 200);
  });
  req.on('error', () => cb(false));
  req.setTimeout(2000, () => { req.destroy(); cb(false); });
}

function startTuiServer() {
  const base = 'http://127.0.0.1:4096';
  healthOk(base, (ok) => {
    if (ok) return;
    const exe = resolveOpenCodeExe();
    const project = state.tuiProject || process.cwd();
    try {
      const child = spawn(exe, ['serve', '--port', '4096'], {
        cwd: project,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      tuiProc = child;
    } catch (e) {
      console.error('startTuiServer', e);
    }
  });
}

function stopTuiServer() {
  if (tuiProc && tuiProc.pid) {
    try { process.kill(tuiProc.pid); } catch {}
    tuiProc = null;
  }
}

// ---------------- 窗口 ----------------

function createPetWindow() {
  petWindow = new BrowserWindow({
    width: PET_W,
    height: PET_H,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  petWindow.setAlwaysOnTop(true, 'screen-saver');
  petWindow.loadFile(path.join(__dirname, 'renderer', 'pet.html'));

  const cfg = readConfig();
  if (cfg.petPosition) petWindow.setPosition(cfg.petPosition.x, cfg.petPosition.y);
  if (typeof cfg.popupVisible === 'boolean') state.popupVisible = cfg.popupVisible;
  if (typeof cfg.petClickThrough === 'boolean') {
    state.petClickThrough = cfg.petClickThrough;
    applyClickThrough();
  }

  // 拖动跟随：每个 move 事件直接跟随（positionPopup 内有 >1px 去抖与 workArea 缓存），
  // 无节流/轮询，拖动时弹窗与桌宠同步移动不卡顿；静止时无任何开销。
  petWindow.on('move', () => positionPopup());
  petWindow.on('moved', () => {
    writeConfig({ ...readConfig(), petPosition: petWindow.getBounds() });
    positionPopup();
  });
  petWindow.on('closed', () => { petWindow = null; });
  petWindow.webContents.on('context-menu', (e, params) => {
    e.preventDefault();
    showPetMenu(params.x + petWindow.getBounds().x, params.y + petWindow.getBounds().y);
  });
}

function createPopupWindow() {
  popupWindow = new BrowserWindow({
    width: POPUP_W,
    height: POPUP_H,
    // 恢复透明窗口以支持真正的“看得到背景”的透明度功能。
    // 闪烁已由 app.disableHardwareAcceleration() 缓解（Windows 透明窗口合成的标准修复）。
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: state.popupVisible,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  popupWindow.setAlwaysOnTop(true, 'screen-saver');
  // 尺寸锁定：防止 Windows 透明窗口在拖动/合成时出现尺寸漂移（弹窗“扩大”）
  popupWindow.setMinimumSize(POPUP_W, POPUP_H);
  popupWindow.setMaximumSize(POPUP_W, POPUP_H);
  popupWindow.loadFile(path.join(__dirname, 'renderer', 'popup.html'));
  popupWindow.on('closed', () => { popupWindow = null; });
  // 初始化缓存宽高（从配置读取，默认基础尺寸）
  const cfg = readConfig();
  state.popupCachedW = typeof cfg.popupCachedW === 'number' ? cfg.popupCachedW : POPUP_W;
  state.popupCachedH = typeof cfg.popupCachedH === 'number' ? cfg.popupCachedH : POPUP_H;
}

let cachedWa = null;
let cachedWaKey = '';
function getCachedWorkArea(pb) {
  const key = pb.x + ',' + pb.y + ',' + pb.width + ',' + pb.height;
  if (cachedWa && key === cachedWaKey) return cachedWa;
  cachedWaKey = key;
  cachedWa = screen.getDisplayMatching(pb).workArea;
  return cachedWa;
}

function positionPopup() {
  if (!petWindow || petWindow.isDestroyed() || !popupWindow || popupWindow.isDestroyed()) return;
  // 弹窗隐藏（屏幕外）时不重新定位
  if (!state.popupVisible) return;
  const pb = petWindow.getBounds();
  const workArea = getCachedWorkArea(pb);
  // 使用缓存的宽高，避免 getBounds() 实时读取导致的渲染抖动
  const curW = state.popupCachedW, curH = state.popupCachedH;
  let x = Math.round(pb.x + pb.width / 2 - curW / 2);
  let y = pb.y - curH - 8;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - curW));
  if (y < workArea.y) y = pb.y + pb.height + 8;
  // 仅当位置实际变化超过 1px 时更新；用 setBounds 显式带上尺寸，
  // 避免 Windows 透明窗口被快速 setPosition 移动时 DWM 合成出现尺寸漂移（弹窗“扩大”）
  const pwb = popupWindow.getBounds();
  if (Math.abs(pwb.x - x) > 1 || Math.abs(pwb.y - y) > 1) {
    popupWindow.setBounds({ x, y, width: curW, height: curH });
  }
}

function applyPetScale() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const s = state.petScale;
  const c = petWindow.getBounds();
  const w = Math.round(PET_W * s);
  const h = Math.round(PET_H * s);
  petWindow.setBounds({ x: Math.round(c.x + c.width / 2 - w / 2), y: Math.round(c.y + c.height / 2 - h / 2), width: w, height: h });
  positionPopup();
}

function applyPopupScale() {
  if (!popupWindow || popupWindow.isDestroyed()) return;
  const s = state.popupScale;
  const c = popupWindow.getBounds();
  const w = Math.round(POPUP_W * s);
  const h = Math.round(POPUP_H * s);
  popupWindow.setBounds({ x: Math.round(c.x + c.width / 2 - w / 2), y: Math.round(c.y + c.height / 2 - h / 2), width: w, height: h });
  // 随缩放同步更新尺寸锁定
  popupWindow.setMinimumSize(w, h);
  popupWindow.setMaximumSize(w, h);
  state.popupCachedW = w;
  state.popupCachedH = h;
  writeConfig({ ...readConfig(), popupCachedW: w, popupCachedH: h });
  positionPopup();
}

function setPetScale(s) {
  state.petScale = Math.min(2.5, Math.max(0.4, Math.round(s * 10) / 10));
  writeConfig({ ...readConfig(), petScale: state.petScale });
  applyPetScale();
}

function setPopupScale(s) {
  state.popupScale = Math.min(2.5, Math.max(0.4, Math.round(s * 10) / 10));
  writeConfig({ ...readConfig(), popupScale: state.popupScale });
  applyPopupScale();
}

function setPopupOpacity(v) {
  // v 为 0-100 百分比，最低 50%
  const pct = Math.min(100, Math.max(50, Math.round(v)));
  // 值未变化时不重复发送，防止透明度意外重置
  if (state.popupOpacity === pct) return;
  state.popupOpacity = pct;
  writeConfig({ ...readConfig(), popupOpacity: pct });
  if (popupWindow && !popupWindow.isDestroyed()) {
    // 透明度完全由 CSS 变量 --bg-alpha 控制，不再调用 setOpacity（避免透明窗口 DWM 闪黑）
    popupWindow.webContents.send('popup-opacity-changed', { opacity: pct / 100 });
  }
}

function applyPopupTop() {
  if (!popupWindow || popupWindow.isDestroyed()) return;
  if (state.popupAlwaysTop) popupWindow.setAlwaysOnTop(true, 'screen-saver');
  else popupWindow.setAlwaysOnTop(false);
}

function togglePopupTop() {
  state.popupAlwaysTop = !state.popupAlwaysTop;
  writeConfig({ ...readConfig(), popupAlwaysTop: state.popupAlwaysTop });
  applyPopupTop();
}

function applyClickThrough() {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.setIgnoreMouseEvents(state.petClickThrough, { forward: true });
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.setIgnoreMouseEvents(state.petClickThrough, { forward: true });
  }
}

function togglePetClickThrough() {
  state.petClickThrough = !state.petClickThrough;
  writeConfig({ ...readConfig(), petClickThrough: state.petClickThrough });
  applyClickThrough();
}

const POPUP_OFFSCREEN = -10000;
function hidePopupWindow() {
  if (!popupWindow || popupWindow.isDestroyed()) return;
  // 透明窗口避免 hide()/show() 循环（Windows DWM 重合成是闪烁主因），改为移到屏幕外
  popupWindow.setPosition(POPUP_OFFSCREEN, POPUP_OFFSCREEN);
}
function showPopupWindow() {
  if (!popupWindow || popupWindow.isDestroyed()) return;
  if (!popupWindow.isVisible()) popupWindow.showInactive();
  positionPopup();
}

function togglePopup() {
  state.popupVisible = !state.popupVisible;
  writeConfig({ ...readConfig(), popupVisible: state.popupVisible });
  if (popupWindow && !popupWindow.isDestroyed()) {
    if (state.popupVisible) {
      showPopupWindow();
    } else {
      hidePopupWindow();
    }
  }
}

// ---------------- 桌宠创建窗口 ----------------

function createCreateWindow() {
  createWindow = new BrowserWindow({
    width: 400,
    height: 400,
    title: '创建桌宠',
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    icon: iconPath,
    autoHideMenuBar: true,
    backgroundColor: '#16181f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  createWindow.setMenuBarVisibility(false);
  createWindow.loadFile(path.join(__dirname, 'renderer', 'create.html'));
  createWindow.on('closed', () => { createWindow = null; });
}

function openCreateChar() {
  if (!createWindow || createWindow.isDestroyed()) createCreateWindow();
  createWindow.show();
  createWindow.focus();
}

function closeCreateChar() {
  if (createWindow && !createWindow.isDestroyed()) createWindow.close();
}

function opacityMenuItems() {
  const s = state.popupOpacity;
  const items = [100, 90, 80, 70, 60, 50].map((p) => ({
    label: `${p}%`,
    type: 'radio',
    checked: s === p,
    click: () => setPopupOpacity(p),
  }));
  items.push({ type: 'separator' });
  items.push({ label: '增+5%', click: () => setPopupOpacity(state.popupOpacity + 5) });
  items.push({ label: '降-5%', click: () => setPopupOpacity(state.popupOpacity - 5) });
  return items;
}

function scaleMenuItems(kind) {
  const key = kind === 'pet' ? 'petScale' : 'popupScale';
  const s = state[key];
  const items = [2, 1.5, 1.2, 1, 0.8, 0.6].map((p) => ({
    label: Math.round(p * 100) + '%',
    type: 'radio',
    checked: Math.abs(s - p) < 0.001,
    click: () => (kind === 'pet' ? setPetScale(p) : setPopupScale(p)),
  }));
  items.push({ type: 'separator' });
  items.push({ label: '放大 +10%', click: () => (kind === 'pet' ? setPetScale(state.petScale + 0.1) : setPopupScale(state.popupScale + 0.1)) });
  items.push({ label: '缩小 -10%', click: () => (kind === 'pet' ? setPetScale(state.petScale - 0.1) : setPopupScale(state.popupScale - 0.1)) });
  return items;
}

async function deleteSession(id) {
  if (!id) return false;
  const r = await dialog.showMessageBox(petWindow, {
    type: 'warning',
    buttons: ['删除', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: '删除任务',
    message: '确定删除该 OpenCode 任务吗？此操作不可恢复。',
    detail: id,
  });
  if (r.response !== 0) return false;
  // 先乐观更新界面：立即从任务列表移除并清理缓存，删除进程在后台执行，
  // 避免等待 CLI 删除期间界面卡住。
  state.sessions = state.sessions.filter((s) => s.id !== id);
  progressCache.delete(id);
  broadcastSessions();
  if (state.sessionId === id) {
    state.sessionId = null;
    state.lastUpdated = 0;
    state.exportCache = null;
  }
  const { err } = await runCmd(`opencode session delete ${id}`);
  if (err) {
    pollProgress();
    return false;
  }
  if (state.pinnedId === id) {
    selectSession('latest');
  } else {
    pollProgress();
  }
  return true;
}

// ---------------- 自定义右键菜单（子菜单统一右侧展开） ----------------

function characterMenuItems() {
  const chars = listCharacters();
  const items = chars.map((c) => {
    const item = {
      label: c.name,
      type: 'checkbox',
      checked: !!state.currentChar && state.currentChar.name === c.name,
      click: () => setCharacter(c.name),
    };
    if (!c.builtin) item.del = () => deleteCharacter(c.name);
    return item;
  });
  items.push({ type: 'separator' });
  items.push({ label: '＋ 创建桌宠', click: () => openCreateChar() });
  return items;
}

// 彻底移除缓存：菜单极小，每次现生成，确保 actionId 始终有效
function buildMenuItems() {
  const items = [
    { label: '选择桌宠', submenu: characterMenuItems() },
    { label: '桌宠尺寸', submenu: scaleMenuItems('pet') },
    { label: '进度弹窗尺寸', submenu: scaleMenuItems('popup') },
    { label: '进度弹窗透明度', submenu: opacityMenuItems() },
    { type: 'separator' },
    { label: '桌宠置顶', type: 'checkbox', checked: state.popupAlwaysTop, click: () => togglePopupTop() },
    { label: '鼠标穿透', type: 'checkbox', checked: state.petClickThrough, click: () => togglePetClickThrough() },
    { type: 'separator' },
    { label: state.popupVisible ? '隐藏进度弹窗' : '显示进度弹窗', click: () => togglePopup() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ];
  return serializeItems(items);
}

function serializeItems(items) {
  return items.map((item) => {
    const out = {
      type: item.type || 'normal',
      label: item.label,
      checked: !!item.checked,
      enabled: item.enabled !== false,
    };
    if (item.submenu) out.submenu = serializeItems(item.submenu);
    if (typeof item.click === 'function') {
      out.actionId = 'act' + (menuActionSeq++);
      menuActionMap.set(out.actionId, item.click);
    }
    if (typeof item.del === 'function') {
      out.delActionId = 'del' + (menuActionSeq++);
      menuDelMap.set(out.delActionId, item.del);
    }
    return out;
  });
}

function createMenuWindow() {
  menuWindow = new BrowserWindow({
    width: 300,
    height: 240,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  menuWindow.setAlwaysOnTop(true, 'screen-saver');
  menuWindow.loadFile(path.join(__dirname, 'renderer', 'menu.html'));
  menuWindow.on('blur', () => {
    // 延迟隐藏，避免焦点切换瞬间误触发；只有真正失去焦点才隐藏
    setTimeout(() => {
      if (menuWindow && !menuWindow.isDestroyed() && !menuWindow.isFocused()) {
        menuWindow.hide();
      }
    }, 100);
  });
  menuWindow.on('closed', () => { menuWindow = null; });
}

function popupMenu(pos) {
  if (!menuWindow || menuWindow.isDestroyed()) return;
  // 不在此处 hide()，避免 hide→show 循环导致的闪烁；内容重新渲染后由 menu-ready 决定显示
  menuActionSeq = 0;
  menuActionMap.clear();
  menuDelMap.clear();
  // 记录右键点击的屏幕坐标（用于左下角对齐）
  lastMenuPos = { x: Math.round(pos.x), y: Math.round(pos.y) };
  const wa = screen.getDisplayNearestPoint(lastMenuPos).bounds;  // 使用整个屏幕区域，允许覆盖任务栏
  const pw = Math.max(240, Math.min(560, wa.x + wa.width - lastMenuPos.x));
  // 初始高度预估：使用 200px 更接近实际菜单高度，减少 menu-fit 修正时的跳动
  const ph = 200;
  // 先定位到鼠标位置附近，menu-fit 会根据实际内容高度修正左下角对齐
  const x = lastMenuPos.x;
  const y = lastMenuPos.y - ph;
  menuWindow.setBounds({ x, y, width: pw, height: ph });
  // 每次现生成，确保 actionId 始终有效
  const items = buildMenuItems();
  menuWindow.webContents.send('menu-show', { items });
}

function hideMenu() {
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.hide();
}

function showPetMenu(mx, my) {
  popupMenu({ x: mx, y: my });
}

function createTray() {
  const img = fs.existsSync(trayIconPath)
    ? nativeImage.createFromPath(trayIconPath)
    : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('XiaoA');
  tray.on('right-click', () => {
    popupMenu(screen.getCursorScreenPoint());
  });
  tray.on('double-click', () => togglePopup());
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.handle('get-progress', () => state.progress);
  ipcMain.handle('get-sessions', () => ({ sessions: state.sessions, following: state.following, pinnedId: state.pinnedId }));
  ipcMain.handle('get-characters', () => listCharacters().map((c) => ({ name: c.name, builtin: c.builtin, files: c.files })));
  ipcMain.handle('get-current-character', () => state.currentChar ? { name: state.currentChar.name, files: state.currentChar.files } : null);
  ipcMain.on('set-character', (e, name) => setCharacter(name));
  ipcMain.handle('delete-character', (e, name) => deleteCharacter(name));
  ipcMain.handle('pick-image', async (e, title) => {
    const r = await dialog.showOpenDialog(createWindow || petWindow, {
      title: title || '选择图片',
      properties: ['openFile'],
      filters: [{ name: '图片（SVG/PNG）', extensions: ['svg', 'png'] }],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  ipcMain.handle('create-character', (e, data) => createCharacter(data));
  ipcMain.on('create-close', () => closeCreateChar());
  ipcMain.on('select-session', (e, id) => selectSession(id));
  ipcMain.handle('delete-session', (e, id) => deleteSession(id));
  ipcMain.on('menu-click', (e, id) => {
    const fn = menuActionMap.get(id);
    hideMenu();
    if (fn) { try { fn(); } catch (err) { console.error('menu-click', err); } }
  });
  ipcMain.on('menu-del', async (e, id) => {
    const fn = menuDelMap.get(id);
    if (fn) { try { await fn(); } catch (err) { console.error('menu-del', err); } }
    if (menuWindow && !menuWindow.isDestroyed()) {
      popupMenu(lastMenuPos);
    }
  });
  ipcMain.on('menu-hide', () => hideMenu());
  ipcMain.handle('grant-permission', (e, allow) => grantPermission(!!allow));
  ipcMain.on('permission-hide', () => { if (permissionWindow && !permissionWindow.isDestroyed()) permissionWindow.hide(); });
  ipcMain.on('menu-fit', (e, size) => {
    if (!menuWindow || menuWindow.isDestroyed()) return;
    const wa = screen.getDisplayNearestPoint(lastMenuPos).bounds;
    const w = Math.max(120, Math.min(Math.round(size.width || 260), wa.width));
    const h = Math.max(80, Math.min(Math.round(size.height || 200), wa.height));
    // 根菜单高度（用于左下角对齐），子菜单向下延伸不影响根菜单底部对齐
    const rootH = Math.max(80, Math.min(Math.round(size.rootHeight || h), wa.height));
    // 根菜单左下角精确对齐右键点击位置；窗口可能比根菜单高（容纳子菜单）
    let x = Math.max(wa.x, Math.min(lastMenuPos.x, wa.x + wa.width - w));
    let y = lastMenuPos.y - rootH;
    // 边界保护：保证窗口整体不超出屏幕
    if (y < wa.y) y = wa.y;
    if (y + h > wa.y + wa.height) y = wa.y + wa.height - h;
    menuWindow.setBounds({ x, y, width: w, height: h });
  });
  ipcMain.on('menu-ready', () => {
    if (!menuWindow || menuWindow.isDestroyed()) return;
    if (!menuWindow.isVisible()) {
      // 先 showInactive() 无焦点切换地绘制，避免闪烁；稍后 focus() 以获得焦点（blur 可关闭菜单）
      menuWindow.showInactive();
      setTimeout(() => {
        if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) {
          menuWindow.focus();
        }
      }, 60);
    }
  });
  ipcMain.on('toggle-popup', () => togglePopup());
  ipcMain.on('copy-text', (e, text) => clipboard.writeText(text || ''));
  ipcMain.on('quit', () => app.quit());
}

// ---------------- 启动 ----------------

app.whenReady().then(() => {
  app.setName('XiaoA');
  app.setAppUserModelId('XiaoA');
  fs.mkdirSync(petsDir, { recursive: true });
  migrateBundledPets();
  registerIpc();
  createMenuWindow();
  createPetWindow();
  createPopupWindow();
  createTray();
  applyPetScale();
  applyPopupScale();
  applyPopupTop();
  positionPopup();
  // 首次加载完成时发送透明度（后续不再发送，避免重复）
  let popupOpacitySent = false;
  popupWindow.webContents.on('did-finish-load', () => {
    if (!popupOpacitySent) {
      popupOpacitySent = true;
      // 透明度完全由 CSS 变量 --bg-alpha 控制，不再调用 setOpacity
      popupWindow.webContents.send('popup-opacity-changed', { opacity: state.popupOpacity / 100 });
    }
  });

  const cfg = readConfig();
  migrateLoosePets();
  if (!cfg.currentChar && !cfg.currentPet) {
    try {
      const legacyPath = path.join(app.getPath('appData'), 'opencode-desktop-pet', 'pet-config.json');
      const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
      if (legacy.currentPet) cfg.currentPet = legacy.currentPet;
    } catch { }
  }
  if (typeof cfg.following === 'boolean') state.following = cfg.following;
  if (cfg.pinnedId) state.pinnedId = cfg.pinnedId;
  if (typeof cfg.petScale === 'number') state.petScale = cfg.petScale;
  if (typeof cfg.popupScale === 'number') state.popupScale = cfg.popupScale;
  if (typeof cfg.popupOpacity === 'number') {
    // 迁移旧版本 (0-1) 到新版本 (0-100)
    state.popupOpacity = cfg.popupOpacity > 1 ? Math.round(cfg.popupOpacity) : Math.round(cfg.popupOpacity * 100);
  }
  if (typeof cfg.popupAlwaysTop === 'boolean') state.popupAlwaysTop = cfg.popupAlwaysTop;
  applyPopupTop();
  if (cfg.opencodeServer) {
    state.opencodeServer = String(cfg.opencodeServer).replace(/\/+$/, '');
    startSse(state.opencodeServer);
  } else {
    probeServer(() => {
      if (!state.opencodeServer) startTuiServer();
    });
  }
  state.tuiProject = cfg.opencodeProject || process.cwd();
  if (cfg.opencodeServer && state.opencodeServer === 'http://127.0.0.1:4096') {
    startTuiServer();
  }
  const chars = listCharacters();
  let curChar = chars.find((c) => c.name === cfg.currentChar);
  if (!curChar && cfg.currentPet) {
    curChar = chars.find((c) => c.name === sanitizeCharName(path.basename(cfg.currentPet, path.extname(cfg.currentPet))));
  }
  if (!curChar) curChar = chars.find((c) => c.name === '小A') || chars[0];
  if (curChar) {
    state.currentChar = { name: curChar.name, dir: curChar.dir, builtin: curChar.builtin, files: curChar.files };
    if (!cfg.currentChar) writeConfig({ ...readConfig(), currentChar: curChar.name });
    petWindow.webContents.once('did-finish-load', () => {
      petWindow.webContents.send('pet-changed', { name: state.currentChar.name, files: state.currentChar.files });
    });
  }

  pollProgress();
  progressTimer = setInterval(pollProgress, POLL_INTERVAL);
  probeTimer = setInterval(ensureServerConnection, 20000);

  if (process.env.SMOKE_TEST) {
    setTimeout(() => {
      console.log('SMOKE_RESULT=' + JSON.stringify(state.progress));
      setTimeout(() => app.quit(), 500);
    }, 8000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createPetWindow();
      createPopupWindow();
    }
  });
});

app.on('window-all-closed', (e) => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (progressTimer) clearInterval(progressTimer);
  if (probeTimer) clearInterval(probeTimer);
  if (parseWorker) {
    try { parseWorker.terminate(); } catch {}
  }
  stopTuiServer();
});