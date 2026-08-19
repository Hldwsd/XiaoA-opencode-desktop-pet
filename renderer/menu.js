'use strict';

const rootEl = document.getElementById('root');
let currentSub = null;

function el(cls, text) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  if (text) d.textContent = text;
  return d;
}

function buildItem(item) {
  if (item.type === 'separator') return el('sep');
  const cls = 'mi'
    + (item.checked ? ' checked' : '')
    + (item.enabled === false ? ' disabled' : '')
    + (item.submenu ? ' has-sub' : '');
  const d = el(cls);
  d.appendChild(el('mark', item.checked ? '✓' : ''));
  d.appendChild(el('txt', item.label || ''));
  if (item.submenu) d.appendChild(el('arr', '▶'));
  if (item.delActionId) {
    const del = el('del', '✕');
    del.dataset.del = item.delActionId;
    d.appendChild(del);
  }
  if (item.actionId) d.dataset.action = item.actionId;
  return d;
}

function render(items) {
  rootEl.innerHTML = '';
  const rootMenu = el('menu');
  items.forEach((it) => rootMenu.appendChild(buildItem(it)));
  rootEl.appendChild(rootMenu);
  items.forEach((it, idx) => {
    if (!it.submenu) return;
    const sub = el('menu sub');
    it.submenu.forEach((s) => sub.appendChild(buildItem(s)));
    rootEl.appendChild(sub);
    rootMenu.children[idx]._sub = sub;
  });
}

function hideAllSubs() {
  currentSub = null;
  rootEl.querySelectorAll('.menu.sub').forEach((s) => { s.style.display = 'none'; });
}

function showSub(itemEl) {
  const sub = itemEl._sub;
  if (!sub) { hideAllSubs(); return; }
  if (currentSub === sub) return;
  hideAllSubs();
  currentSub = sub;
  sub.style.display = 'block';
  rootEl.appendChild(sub);
  const r = itemEl.getBoundingClientRect();
  sub.style.left = Math.round(r.right) + 'px';
  sub.style.top = Math.round(r.top) + 'px';
  if (r.top + sub.offsetHeight > window.innerHeight) {
    sub.style.top = Math.max(0, Math.round(window.innerHeight - sub.offsetHeight)) + 'px';
  }
}

rootEl.addEventListener('mouseover', (e) => {
  const mi = e.target.closest('.mi');
  if (!mi) return;
  if (mi.closest('.menu.sub')) return;
  if (mi._sub) showSub(mi);
  else hideAllSubs();
});

rootEl.addEventListener('click', (e) => {
  const del = e.target.closest('.del');
  if (del) {
    e.stopPropagation();
    window.petAPI.menuDel(del.dataset.del);
    return;
  }
  const mi = e.target.closest('.mi');
  if (!mi) return;
  if (mi.classList.contains('disabled')) return;
  if (mi._sub) { showSub(mi); return; }
  if (mi.dataset.action) window.petAPI.menuClick(mi.dataset.action);
  else window.petAPI.menuHide();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.mi')) window.petAPI.menuHide();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.petAPI.menuHide();
});

window.petAPI.onMenuShow(({ items }) => {
  render(items);
  const subs = rootEl.querySelectorAll('.menu.sub');
  subs.forEach((s) => { s.style.display = 'block'; s.style.visibility = 'hidden'; });
  const rootMenu = rootEl.querySelector('.menu');
  const rootW = rootMenu.offsetWidth;
  const rootH = rootMenu.offsetHeight;
  let neededW = rootW;
  let neededH = rootH;
  rootEl.querySelectorAll('.mi.has-sub').forEach((itemEl) => {
    const sub = itemEl._sub;
    if (!sub) return;
    const r = itemEl.getBoundingClientRect();
    // 宽度容纳子菜单向右延伸；高度取根菜单与子菜单两者的较大值
    neededW = Math.max(neededW, r.right + sub.offsetWidth);
    neededH = Math.max(neededH, sub.offsetHeight);
  });
  subs.forEach((s) => { s.style.display = 'none'; s.style.visibility = ''; });
  // rootHeight = 根菜单高度，主进程据此让根菜单左下角精确对齐鼠标
  window.petAPI.menuFit({ width: neededW, height: neededH, rootHeight: rootH });
  // 渲染完成，通知主进程显示窗口
  window.petAPI.menuReady();
});