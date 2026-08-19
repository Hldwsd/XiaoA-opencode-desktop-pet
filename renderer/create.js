'use strict';

const $ = (id) => document.getElementById(id);
const nameInput = $('name');
const errEl = $('err');
const picks = { working: null, thinking: null, idle: null };

function baseName(p) {
  if (!p) return '';
  const s = String(p).replace(/\\/g, '/');
  return s.split('/').pop();
}

document.querySelectorAll('.pick-row button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const key = btn.dataset.key;
    const title = btn.dataset.title;
    errEl.textContent = '';
    const file = await window.petAPI.pickImage(title);
    if (!file) return;
    picks[key] = file;
    const out = document.querySelector('[data-out="' + key + '"]');
    out.textContent = baseName(file);
    out.classList.add('ok');
  });
});

$('btnCancel').addEventListener('click', () => window.petAPI.closeCreate());

$('btnCreate').addEventListener('click', async () => {
  errEl.textContent = '';
  const name = nameInput.value.trim();
  if (!name) { errEl.textContent = '请输入桌宠名称'; return; }
  for (const key of ['working', 'thinking', 'idle']) {
    if (!picks[key]) {
      const labels = { working: '工作', thinking: '思考', idle: '空闲' };
      errEl.textContent = '请选择「' + labels[key] + '」状态图片';
      return;
    }
  }
  const r = await window.petAPI.createCharacter({
    name,
    work: picks.working,
    think: picks.thinking,
    idle: picks.idle,
  });
  if (r.ok) {
    window.petAPI.closeCreate();
  } else {
    errEl.textContent = r.error || '创建失败';
  }
});

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btnCreate').click();
});