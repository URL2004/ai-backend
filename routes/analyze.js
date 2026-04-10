// [분석 API] 텍스트/PDF AI 탐지 및 휴머나이즈 처리 + Claude API 호출 유틸
// ★ 캐싱 최적화: 고정 프롬프트를 system에 넣어 cache_control 적용

const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { DETECT_SYSTEM, getHumanizeSystem } = require('../prompts');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

// --- 유틸리티 함수 ---

function cleanText(text) {
  return text
    .replace(/[\u200B-\u200D\uFEFF\u00AD\u034F\u061C\u180E\u2000-\u200F\u2028-\u202F\u205F-\u206F]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[*#`~]/g, '')
    .replace(/\.([가-힣A-Za-z])/g, '. $1')
    .replace(/,([가-힣A-Za-z])/g, ', $1')
    .replace(/ {2,}/g, ' ')
    .trim();
}

async function callClaude(messages, tools, temperature, system) {
  const body = {
    model: MODEL,
    max_tokens: 8192,
    messages: messages
  };

  if (tools) body.tools = tools;
  if (temperature !== undefined) body.temperature = temperature;

  // ★ 시스템 프롬프트에 cache_control 적용 (고정 프롬프트가 캐싱됨)
  if (system) {
    body.system = [
      {
        type: "text",
        text: system,
        cache_control: { type: "ephemeral" }
      }
    ];
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (data.usage) {
    console.log("-----------------------------------------");
    console.log(`📊 비용 리포트: 캐시읽기(90%할인) ${data.usage.cache_read_input_tokens || 0} / 캐시생성(25%추가) ${data.usage.cache_creation_input_tokens || 0} / 일반입력 ${data.usage.input_tokens || 0}`);
    console.log("-----------------------------------------");
  }

  return data;
}

function parseJSON(raw) {
  const clean = raw.replace(/```json|```/g, '').trim();
  const firstBrace = clean.indexOf('{');
  if (firstBrace === -1) throw new Error('JSON 없음');
  let depth = 0, end = -1;
  for (let i = firstBrace; i < clean.length; i++) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error('JSON 불완전');
  return JSON.parse(clean.substring(firstBrace, end + 1));
}

// --- 라우트 ---

router.post('/analyze', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] /analyze 요청 IP: ${ip}`);
  try {
    const { mode, text } = req.body;
    if (!text || text.length < 5) return res.json({ error: '텍스트가 너무 짧습니다.' });

    // ★ 감지: 고정 프롬프트는 system(캐싱), 유저 텍스트만 user 메시지
    if (mode === 'detect') {
      const data = await callClaude(
        [{ role: 'user', content: `[분석할 글]\n${text}` }],
        null, undefined,
        DETECT_SYSTEM
      );
      const result = parseJSON(data.content[0].text);
      return res.json({ ok: true, result, usage: data.usage });
    }

    // 웹 검색 (캐싱 불필요)
    let examples = null;
    try {
      const searchData = await callClaude(
        [{ role: 'user', content: `다음 글의 주제를 파악하고, 관련된 구체적인 실제 사례나 통계를 2~3개 간략히 제시해줘. 글: ${text.substring(0, 500)}` }],
        [{ type: 'web_search_20250305', name: 'web_search' }]
      );
      const textContent = searchData.content.filter(c => c.type === 'text').map(c => c.text).join('');
      if (textContent.length > 50) examples = textContent.substring(0, 800);
    } catch(e) {}

    // ★ 휴머나이저: 고정 프롬프트는 system(캐싱), 유저 텍스트만 user 메시지
    const selectedMode = req.body.humanizeMode || 'assignment';
    const humanizeSystem = getHumanizeSystem(selectedMode);
    const userContent = examples
      ? `[재작성할 텍스트]\n${text}\n\n[참고할 실제 사례/통계 (자연스럽게 녹여 활용)]\n${examples}`
      : `[재작성할 텍스트]\n${text}`;
    const data = await callClaude(
      [{ role: 'user', content: userContent }],
      null, undefined,
      humanizeSystem
    );
    const result = parseJSON(data.content[0].text);
    if (result.outputText) result.outputText = cleanText(result.outputText);

    res.json({ ok: true, result, usage: data.usage });

  } catch (err) {
    res.json({ error: err.message });
  }
});

router.post('/analyze-pdf', upload.single('pdf'), async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] /analyze-pdf 요청 IP: ${ip}`);
  try {
    if (!req.file) return res.json({ error: 'PDF 파일이 없습니다.' });
    const mode = req.body.mode || 'detect';
    const pdfData = await pdfParse(req.file.buffer);
    const text = pdfData.text.trim();
    if (!text || text.length < 5) return res.json({ error: 'PDF에서 텍스트를 추출할 수 없습니다.' });

    const systemPrompt = mode === 'detect' ? DETECT_SYSTEM : getHumanizeSystem(req.body.humanizeMode || 'assignment');
    const userContent = mode === 'detect' ? `[분석할 글]\n${text}` : `[재작성할 텍스트]\n${text}`;
    const data = await callClaude(
      [{ role: 'user', content: userContent }],
      null, undefined,
      systemPrompt
    );
    const result = parseJSON(data.content[0].text);
    if (result.outputText) result.outputText = cleanText(result.outputText);

    res.json({
      ok: true,
      result,
      usage: data.usage,
      extractedText: text.substring(0, 500)
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

module.exports = router;
