'use strict';

const $ = (id) => document.getElementById(id);
const proj = $('proj'), op = $('op'), hint = $('hint');
const btnAllow = $('btnAllow'), btnDeny = $('btnDeny');
let submitting = false;

function projectName(dir) {
  if (!dir) return '未知项目';
  const parts = String(dir).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || '未知项目';
}

function onShow(data) {
  proj.textContent = '📁 ' + projectName(data && data.directory);
  const perm = (data && data.permission) || {};
  op.textContent = (perm.action || '未知操作') + (perm.tool ? '（' + perm.tool + '）' : '');
  const connected = !!(data && data.server);
  submitting = false;
  btnAllow.disabled = false;
  btnDeny.disabled = false;
  btnAllow.textContent = '允许';
  btnDeny.textContent = '拒绝';
  if (connected) {
    hint.className = 'hint';
    hint.textContent = '';
  } else {
    hint.className = 'hint show';
    hint.textContent = '未连接 opencode 服务器，请在 opencode 终端中允许或拒绝';
  }
}

async function submit(allow) {
  if (submitting) return;
  submitting = true;
  btnAllow.disabled = true;
  btnDeny.disabled = true;
  const btn = allow ? btnAllow : btnDeny;
  btn.textContent = '提交中…';
  const r = await window.petAPI.grantPermission(allow);
  submitting = false;
  if (r && r.ok) {
    hint.className = 'hint show';
    hint.textContent = allow ? '已允许，等待执行…' : '已拒绝';
    btnAllow.disabled = true;
    btnDeny.disabled = true;
  } else {
    hint.className = 'hint show';
    hint.textContent = (r && r.error) || '提交失败';
    btnAllow.disabled = false;
    btnDeny.disabled = false;
    btnAllow.textContent = '允许';
    btnDeny.textContent = '拒绝';
  }
}

btnAllow.addEventListener('click', () => submit(true));
btnDeny.addEventListener('click', () => submit(false));
$('closeBtn').addEventListener('click', () => window.petAPI.hidePermission());

window.petAPI.onPermission(onShow);