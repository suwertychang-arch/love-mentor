const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── AI 配置（从环境变量读取，用户无需配置）───
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.moonshot.cn/v1';
const AI_MODEL = process.env.AI_MODEL || 'moonshot-v1-8k';

// ─── 房间状态（内存存储，重启即清空）───
const rooms = {};
const ONLINE_THRESHOLD = 15000; // 15秒内有poll就算在线

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      confessions: { male: [], female: [] },
      advices: [],
      lastSeen: { male: 0, female: 0 },
      mentorThinking: false,
      mentorError: null,
    };
  }
  return rooms[roomId];
}

function isOnline(room, identity) {
  return Date.now() - room.lastSeen[identity] < ONLINE_THRESHOLD;
}

function getFilteredState(room, identity) {
  return {
    online: {
      male: isOnline(room, 'male'),
      female: isOnline(room, 'female'),
    },
    myConfessions: room.confessions[identity] || [],
    advices: room.advices,
    mentorThinking: room.mentorThinking,
    mentorError: room.mentorError,
  };
}

// ─── AI 导师调用 ───
const MENTOR_SYSTEM_PROMPT = `你是一位温暖、有智慧的情感导师，正在同时帮助一对情侣（男生和女生）。

你收到的是双方各自写下的倾诉内容（情绪标签、场景标签和自由描述）。这些内容对对方是不可见的，你必须在回应中保护双方的隐私。

【核心原则】
1. 认清是谁说的：区分双方的感受与期待，区分本人表达和对另一方的猜测。
2. 信息不足就追问：如果只有一方表达了，先帮助这一方梳理情绪，并温和地邀请另一方也来写写，不要急着对两个人的关系下结论。
3. 一次解决一个小问题：回应尽量简短，先说明理解，再给一两项具体建议，必要时问一个问题。

【回应格式】
用以下三段式回应（如果信息不足，第三段改为邀请对方补充）：

**我理解到的是…**
（说明你理解到的感受，不点名谁说的，绝不转述原话）

**可以试试…**
（1-2 项具体建议，温和、不说教）

**我想问…**
（抛一个问题引导深入，或邀请另一方补充）

【绝对禁忌】
- 绝对不要直接引用某一方的原话
- 绝对不要说"男生说…""女生说…"
- 只描述感受和情绪类型，如"一方感到委屈，另一方感到被误解"
- 不要对整个关系下定论，一次只处理一个小问题
- 语气温暖、像朋友，不要像说教的老师`;

function buildUserPrompt(room) {
  const maleConfs = room.confessions.male || [];
  const femaleConfs = room.confessions.female || [];
  const lastAdvice = room.advices[room.advices.length - 1];

  let prompt = '';

  if (maleConfs.length > 0) {
    prompt += '【男生倾诉】\n';
    maleConfs.forEach((c, i) => {
      prompt += `第${i + 1}次：情绪[${c.emotion}] 场景[${c.scene}]\n${c.text}\n\n`;
    });
  }

  if (femaleConfs.length > 0) {
    prompt += '【女生倾诉】\n';
    femaleConfs.forEach((c, i) => {
      prompt += `第${i + 1}次：情绪[${c.emotion}] 场景[${c.scene}]\n${c.text}\n\n`;
    });
  }

  if (maleConfs.length === 0 && femaleConfs.length === 0) {
    prompt += '双方都还没有倾诉内容。\n';
  }

  if (maleConfs.length > 0 && femaleConfs.length === 0) {
    prompt += '\n注意：目前只有男生表达了，女生还没有写。请先帮助男生梳理，并邀请女生补充。\n';
  }
  if (femaleConfs.length > 0 && maleConfs.length === 0) {
    prompt += '\n注意：目前只有女生表达了，男生还没有写。请先帮助女生梳理，并邀请男生补充。\n';
  }

  if (lastAdvice) {
    prompt += `\n【上一轮导师建议】\n${lastAdvice.content}\n`;
    prompt += '\n请在上一轮的基础上继续，不要重复之前说过的话。\n';
  }

  return prompt;
}

async function callMentor(room) {
  if (!AI_API_KEY) {
    return { ok: false, error: '服务器未配置 AI API Key，请联系管理员' };
  }

  const userPrompt = buildUserPrompt(room);

  try {
    const url = `${AI_BASE_URL}/chat/completions`;
    const body = {
      model: AI_MODEL,
      messages: [
        { role: 'system', content: MENTOR_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.8,
      max_tokens: 800,
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('AI API error:', resp.status, errText);
      return { ok: false, error: `AI 接口返回错误 (${resp.status})` };
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return { ok: false, error: 'AI 返回内容为空' };
    }

    const advice = {
      id: Date.now().toString(),
      content: content.trim(),
      timestamp: new Date().toISOString(),
    };
    room.advices.push(advice);
    return { ok: true, advice };
  } catch (err) {
    console.error('callMentor error:', err);
    return { ok: false, error: `AI 调用失败: ${err.message}` };
  }
}

// ─── REST API ───

// 轮询 / 心跳
app.post('/api/poll', (req, res) => {
  const { roomId, identity } = req.body;
  if (!roomId || !['male', 'female'].includes(identity)) {
    return res.json({ ok: false, error: '参数无效' });
  }

  const room = getRoom(roomId);
  room.lastSeen[identity] = Date.now();
  res.json({ ok: true, state: getFilteredState(room, identity) });
});

// 提交倾诉
app.post('/api/confess', (req, res) => {
  const { roomId, identity, emotion, scene, text } = req.body;
  if (!roomId || !['male', 'female'].includes(identity)) {
    return res.json({ ok: false, error: '参数无效' });
  }

  const room = getRoom(roomId);
  if (!text || !text.trim()) {
    return res.json({ ok: false, error: '请写点什么' });
  }

  const confession = {
    id: Date.now().toString(),
    emotion: emotion || '未选择',
    scene: scene || '其他',
    text: text.trim(),
    timestamp: new Date().toISOString(),
  };
  room.confessions[identity].push(confession);
  room.lastSeen[identity] = Date.now();

  res.json({ ok: true, confession });
});

// 请导师回应（异步执行，立即返回）
app.post('/api/ask-mentor', async (req, res) => {
  const { roomId, identity } = req.body;
  if (!roomId || !['male', 'female'].includes(identity)) {
    return res.json({ ok: false, error: '参数无效' });
  }

  const room = getRoom(roomId);
  if (room.mentorThinking) {
    return res.json({ ok: false, error: '导师正在思考中，请稍等' });
  }

  room.mentorThinking = true;
  room.mentorError = null;
  room.lastSeen[identity] = Date.now();

  res.json({ ok: true, thinking: true });

  // 异步调用AI
  const result = await callMentor(room);
  room.mentorThinking = false;
  if (!result.ok) {
    room.mentorError = result.error;
  }
});

// 清除导师错误
app.post('/api/clear-error', (req, res) => {
  const { roomId } = req.body;
  if (!roomId) return res.json({ ok: false });
  const room = getRoom(roomId);
  room.mentorError = null;
  res.json({ ok: true });
});

// 定期清理无人的房间
setInterval(() => {
  for (const [id, room] of Object.entries(rooms)) {
    if (Date.now() - room.lastSeen.male > 60000 && Date.now() - room.lastSeen.female > 60000) {
      delete rooms[id];
    }
  }
}, 30000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`情感导师服务已启动: http://localhost:${PORT}`);
  console.log(`AI 配置: ${AI_API_KEY ? '已配置' : '未配置（需要设置环境变量 AI_API_KEY）'}`);
});
