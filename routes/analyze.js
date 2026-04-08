// [분석 API] 텍스트/PDF AI 탐지 및 휴머나이즈 처리 + Claude API 호출 유틸

const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { getDetectPrompt, getPromptByMode } = require('../prompts');

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
  // 캐싱을 적용하고 싶은 메시지(주로 시스템 프롬프트나 긴 지문)에 태그를 붙입니다.
  const updatedMessages = messages.map((msg, index) => {
    // 마지막 메시지(유저 입력)에 캐시 태그를 붙여야 그 앞의 모든 내용이 저장됩니다.
    if (index === messages.length - 1) {
      return {
        ...msg,
        content: [
          {
            type: "text",
            text: msg.content,
            cache_control: { type: "ephemeral" } // ★ 이게 진짜 할인권입니다!
          }
        ]
      };
    }
    return msg;
  });

  const body = {
    model: MODEL,
    max_tokens: 8192,
    messages: updatedMessages
  };

  if (tools) body.tools = tools;
  if (temperature !== undefined) body.temperature = temperature;
  if (system) body.system = system;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31' // ★ 베타 헤더 추가 필수!
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  // 비용 리포트 로그는 동민님이 짠 그대로 유지
  if (data.usage) {
    console.log("-----------------------------------------");
    console.log(`📊 비용 리포트: 읽기(할인) ${data.usage.cache_read_input_tokens || 0} / 생성(정가) ${data.usage.cache_creation_input_tokens || 0}`);
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

    if (mode === 'detect') {
      const data = await callClaude([{ role: 'user', content: getDetectPrompt(text) }]);
      const result = parseJSON(data.content[0].text);

      return res.json({
        ok: true,
        result,
        usage: data.usage
      });
    }

    let examples = null;
    try {
      const searchData = await callClaude(
        [{ role: 'user', content: `다음 글의 주제를 파악하고, 관련된 구체적인 실제 사례나 통계를 2~3개 간략히 제시해줘. 글: ${text.substring(0, 500)}` }],
        [{ type: 'web_search_20250305', name: 'web_search' }]
      );
      const textContent = searchData.content.filter(c => c.type === 'text').map(c => c.text).join('');
      if (textContent.length > 50) examples = textContent.substring(0, 800);
    } catch(e) {}

   const selectedMode = req.body.humanizeMode || 'assignment'; // 값이 없으면 과제로 고정
   const prompt = getPromptByMode(text, selectedMode);
   const data = await callClaude([{ role: 'user', content: prompt }]);
    const result = parseJSON(data.content[0].text);
    if (result.outputText) result.outputText = cleanText(result.outputText);

    res.json({
      ok: true,
      result,
      usage: data.usage
    });

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

    const prompt = mode === 'detect' ? getDetectPrompt(text) : getPromptByMode(text, req.body.humanizeMode);
    const data = await callClaude([{ role: 'user', content: prompt }]);
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
