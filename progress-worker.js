'use strict';
const { parentPort } = require('worker_threads');

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

function describeAction(tool, input) {
  const first = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, 200);
  switch (tool) {
    case 'bash': return TOOL_LABELS.bash + '：' + first(input.command);
    case 'edit': case 'write': return TOOL_LABELS.edit + '：' + first(input.filePath);
    case 'read': return TOOL_LABELS.read + '：' + first(input.filePath || input.pattern);
    case 'webfetch': return TOOL_LABELS.webfetch + '：' + first(input.url);
    case 'websearch': return TOOL_LABELS.websearch + '：' + first(input.query);
    case 'task': return TOOL_LABELS.task + '：' + first(input.description || input.prompt);
    case 'glob': return TOOL_LABELS.glob + '：' + first(input.pattern);
    default: {
      const keys = Object.keys(input || {});
      const vals = keys.map((k) => k + '=' + first(input[k]));
      return '调用工具 ' + tool + (vals.length ? '：' + vals.join('，').slice(0, 200) : '');
    }
  }
}

function parseExport(j) {
  const info = j.info || {};
  const messages = Array.isArray(j.messages) ? j.messages : [];
  const model = info.model ? (info.model.id || '') : '';

  let working = false;
  let lastMsgActive = false;   // 最后一条 assistant 消息是否仍在进行中（未完成）
  let finish = null;
  let lastActivity = 0;
  let currentTool = null;
  let currentToolState = null;
  let latestReasoning = '';
  let latestText = '';
  let totalTools = 0;
  let doneTools = 0;
  let runningTools = 0;
  let steps = 0;
  let todos = null;
  const pending = { tool: null, action: '', callID: null };
  let runningBlocked = null;
  const now = Date.now();
  // 运行中的工具若超过 5 分钟没有任何时间戳更新，视为陈旧（任务实际已停）
  const STALE_RUN_MS = 300000;

  for (const m of messages) {
    const mi = m.info || {};
    const parts = m.parts || [];
    if (mi.role === 'assistant') {
      finish = mi.finish || null;
      lastMsgActive = !(mi.time && mi.time.completed);
      const created = mi.time && mi.time.created;
      if (created) lastActivity = Math.max(lastActivity, created);
    }
    for (const p of parts) {
      if (p.type === 'tool') {
        totalTools++;
        const st = p.state || {};
        if (st.status === 'completed') doneTools++;
        else if (st.status === 'running') {
          const stt = st.time || {};
          const toolStart = stt.start || 0;
          const toolEnd = stt.end || 0;
          const toolRef = Math.max(toolStart, toolEnd, stt.output || 0);
          const stale = toolRef > 0 && (now - toolRef) > STALE_RUN_MS;
          if (!stale) {
            runningTools++;
            working = true;
            currentTool = st.input && (st.input.command || st.input.filePath || st.input.url) || p.tool;
            currentToolState = st;
            const hasOutput = st.output !== undefined && st.output !== null;
            const hasEnd = st.end !== undefined && st.end !== null;
            if (!runningBlocked && !hasOutput && !hasEnd) {
              runningBlocked = {
                tool: p.tool,
                action: describeAction(p.tool, st.input || {}),
                callID: p.callID || null,
                state: st,
              };
            }
          }
        } else if (st.status === 'pending') {
          pending.tool = p.tool;
          pending.action = describeAction(p.tool, st.input || {});
          pending.callID = p.callID || null;
        }
        if (st.time && st.time.start) lastActivity = Math.max(lastActivity, st.time.start);
        const tod = (st.metadata && Array.isArray(st.metadata.todos) && st.metadata.todos.length && st.metadata.todos)
          || (st.input && Array.isArray(st.input.todos) && st.input.todos.length && st.input.todos);
        if (tod) todos = tod;
      } else if (p.type === 'step-finish') {
        steps++;
      } else if (p.type === 'reasoning' && p.text) {
        latestReasoning = p.text;
        if (p.time && p.time.start) lastActivity = Math.max(lastActivity, p.time.start);
      } else if (p.type === 'text' && p.text) {
        latestText = p.text;
        if (p.time && p.time.start) lastActivity = Math.max(lastActivity, p.time.start);
      } else if (p.time && p.time.start) {
        lastActivity = Math.max(lastActivity, p.time.start);
      }
    }
  }

  let todoTotal = 0;
  let todoDone = 0;
  if (todos && todos.length) {
    todoTotal = todos.length;
    todoDone = todos.filter((x) => (x.status || '') === 'completed').length;
  }

  // 活跃窗口：以会话 info.time.updated（最近写入时间）为准，比 part 时间戳更可靠
  const ACTIVE_MS = 120000; // 2 分钟内有写入视为活跃
  const infoUpdated = (info.time && info.time.updated) || lastActivity || now;
  const updatedAgoMs = now - Math.max(lastActivity, infoUpdated);
  const active = updatedAgoMs <= ACTIVE_MS;

  // 判定优先级：
  //   error > 刚完成(done) > 活跃且有运行中工具(working) > 活跃且消息进行中(thinking) > 其余 idle
  let status = 'idle';
  if (finish === 'error') {
    status = 'error';
  } else if (finish === 'complete' || finish === 'done' || finish === 'stop') {
    // 会话本轮已结束：最近 2 分钟内完成显示 done，之后回落到 idle
    status = active ? 'done' : 'idle';
  } else if (runningTools > 0 && active) {
    status = 'working';
  } else if (lastMsgActive && active) {
    status = 'thinking';
  } else {
    status = 'idle';
  }

  const idle = status === 'idle';

  return {
    sessionId: info.id || null,
    title: info.title || '(无标题会话)',
    directory: info.directory || '',
    model: model || (messages.length ? (messages[messages.length - 1].info?.modelID || '') : ''),
    status,
    idle,
    working,
    finish,
    currentTool,
    currentToolState,
    latestReasoning: (latestReasoning || '').slice(0, 600),
    latestText: (latestText || '').slice(0, 400),
    tools: { done: doneTools, total: totalTools, running: runningTools },
    steps,
    todos: { total: todoTotal, done: todoDone },
    permission: pending.tool ? { tool: pending.tool, action: pending.action, callID: pending.callID } :
           runningBlocked ? { tool: runningBlocked.tool, action: runningBlocked.action, callID: runningBlocked.callID } : null,
    updatedAgoMs,
    updatedAt: lastActivity || Date.now(),
    tokens: info.tokens || null,
  };
}

parentPort.on('message', (msg) => {
  try {
    const j = JSON.parse(msg.raw);
    parentPort.postMessage({ id: msg.id, progress: parseExport(j) });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: String((e && e.message) || e) });
  }
});