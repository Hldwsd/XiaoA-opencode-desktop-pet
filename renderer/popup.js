'use strict';

const $ = (id) => document.getElementById(id);
const dot = $('dot'), title = $('title'), status = $('status');
const cmd = $('cmd'), body = $('body'), barfill = $('barfill');
const toolcount = $('toolcount'), model = $('model');
const pct = $('pct'), bar = $('bar'), metaProgress = $('metaProgress');
const dd = $('dd'), ddToggle = $('ddToggle'), ddLabel = $('ddLabel'), ddList = $('ddList');
let curSessionId = null;

const STATUS_LABEL = {
  working: '工作中',
  thinking: '思考中',
  done: '已完成',
  error: '出错',
  idle: '空闲',
  loading: '加载中…',
};

function render(p) {
  if (!p) return;
  curSessionId = p.sessionId;
  const st = p.status || 'idle';

  if (st === 'loading') {
    dot.className = 'dot idle';
    status.className = 'status idle';
    status.textContent = '加载中…';
    title.textContent = p.title || '切换任务…';
    title.title = '';
    cmd.textContent = '…';
    cmd.classList.remove('error-line');
    body.textContent = '正在加载任务…';
    metaProgress.classList.add('hidden');
    pct.textContent = '';
    toolcount.textContent = '';
    model.textContent = '';
    return;
  }

  dot.className = 'dot ' + st;
  status.className = 'status ' + st;
  status.textContent = p.idle ? '空闲' : (STATUS_LABEL[st] || st);

  title.textContent = p.title || '(无标题)';
  title.title = p.directory || '';

  if (p.currentTool) {
    cmd.textContent = p.currentTool;
    cmd.classList.toggle('error-line', st === 'error');
  } else {
    cmd.textContent = st === 'working' || st === 'thinking' ? '正在准备工具…' : '暂无执行中的命令';
    cmd.classList.remove('error-line');
  }

  let txt = '';
  if (p.latestText) txt = p.latestText;
  else if (p.latestReasoning) txt = '思考中：' + p.latestReasoning;
  else if (st === 'working') txt = 'Agent 正在执行任务…';
  else if (st === 'idle') txt = '等待 OpenCode 任务…';
  else if (st === 'error') txt = '任务出错：' + (p.error || p.latestText || '未知错误');
  body.textContent = txt;

  const hasSteps = (p.todos && p.todos.total > 0);
  const running = st === 'working' || st === 'thinking';
  const hasTools = !!(p.tools && p.tools.total > 0);
  // 没有 todo 列表时进度条/百分比也不隐藏：有步骤、正在运行/思考、或有工具进度都显示
  const showProgress = hasSteps || running || hasTools;

  let ratio = 0;
  if (hasSteps) ratio = Math.min(100, Math.round((p.todos.done || 0) / p.todos.total * 100));
  else if (hasTools) ratio = Math.min(100, Math.round((p.tools.done || 0) / p.tools.total * 100));

  barfill.style.transform = `scaleX(${showProgress ? ratio / 100 : 0})`;
  pct.textContent = showProgress ? ratio + '%' : '';
  metaProgress.classList.toggle('hidden', !showProgress);
  metaProgress.dataset.hasProgress = showProgress;

  if (hasSteps) {
    toolcount.textContent = `步骤 ${p.todos.done}/${p.todos.total}`;
  } else {
    const { done, total } = p.tools || { done: 0, total: 0 };
    toolcount.textContent = `工具 ${done}/${total}`;
  }

  model.textContent = p.model || '';
}

cmd.addEventListener('click', () => {
  if (cmd.textContent) window.petAPI.copyText(cmd.textContent);
  const old = cmd.textContent;
  cmd.textContent = '已复制';
  setTimeout(() => { if (cmd) cmd.textContent = old; }, 800);
});

let lastSelected = 'latest';
let sessionSig = '';
function renderSessions(p) {
  if (!p || !Array.isArray(p.sessions)) return;
  const sig = JSON.stringify(p.sessions.map((s) => s.id + '\u0000' + s.title));
  if (sig !== sessionSig) {
    sessionSig = sig;
    ddList.innerHTML = '';
    const addOpt = (id, label, title) => {
      const li = document.createElement('li');
      li.className = 'dd-opt';
      li.dataset.id = id;
      const span = document.createElement('span');
      span.className = 'dd-opt-label';
      span.textContent = label;
      span.title = title || '';
      li.appendChild(span);
      const del = document.createElement('span');
      del.className = 'dd-del';
      del.textContent = '✕';
      del.title = '删除该任务';
      li.appendChild(del);
      ddList.appendChild(li);
    };
    addOpt('latest', '⚡ 自动跟随最新任务');
    p.sessions.forEach((s, i) => {
      addOpt(s.id, (s.title || '(无标题)').slice(0, 24) + (i === 0 ? '（最新）' : ''), s.title);
    });
  }
  const wanted = p.following ? 'latest' : p.pinnedId;
  let chosen = null;
  for (const o of ddList.querySelectorAll('.dd-opt')) {
    if (o.dataset.id === wanted) { chosen = o; break; }
  }
  lastSelected = chosen ? chosen.dataset.id : 'latest';
  const labelEl = ddList.querySelector('.dd-opt[data-id="' + lastSelected + '"] .dd-opt-label');
  ddLabel.textContent = labelEl ? labelEl.textContent : '⚡ 自动跟随最新任务';
}

ddToggle.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  dd.classList.toggle('open');
});

ddList.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
});

ddList.addEventListener('click', (e) => {
    const del = e.target.closest('.dd-del');
    const li = e.target.closest('.dd-opt');
    if (!li) return;
    const id = li.dataset.id;
    e.stopPropagation();
    if (del) {
      dd.classList.remove('open');
      const realId = id === 'latest' ? curSessionId : id;
      if (!realId) return;
      window.petAPI.deleteSession(realId);
      return;
    }
    dd.classList.remove('open');
    if (id === lastSelected) return;
    lastSelected = id;
    window.petAPI.selectSession(id);
  });

// 点击 .dd（开关/列表）之外的任意处收起；统一用 pointerdown，避免 release 的 click 误关
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.dd')) dd.classList.remove('open');
});

window.petAPI.onProgress(render);
window.petAPI.onSessions(renderSessions);
window.petAPI.getProgress().then(render);
window.petAPI.getSessions().then(renderSessions);

// 监听透明度变化，更新 CSS 变量控制背景透明度（防御非法值，避免背景失效变透明）
window.petAPI.onPopupOpacityChanged(({ opacity }) => {
  const a = Number(opacity);
  if (!isFinite(a)) return;
  document.documentElement.style.setProperty('--bg-alpha', String(Math.max(0, Math.min(1, a))));
});