// [분석 API] 텍스트/PDF AI 탐지 및 휴머나이즈 처리 + Claude API 호출 유틸
// ★ 캐싱 최적화: 고정 프롬프트를 system에 넣어 cache_control 적용

const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { getDetectSystem, getHumanizeSystem } = require('../prompts');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

// ★ 구조화 출력용 tool 정의 (JSON.parse 대신 tool_use로 안전하게 객체 수신)
const HUMANIZE_TOOL = {
  name: 'return_humanized_result',
  description: '재작성된 텍스트와 셀프체크 수치를 반환한다. 수치는 outputText를 실제로 세어 채운다 (추정 금지).',
  input_schema: {
    type: 'object',
    properties: {
      outputText: { type: 'string', description: '변환된 글 전체' },
      summary:    { type: 'string', description: '변환 요약 2문장' },
      detail:     { type: 'string', description: '적용한 기법 상세' },
      topNounCounts: {
        type: 'object',
        description: 'outputText에서 가장 많이 등장하는 주제어(명사) 상위 3개와 횟수. 예: {"배출":2,"정부":1}. 어떤 값도 4 이상이면 규칙 7 위반 — 재작성',
        additionalProperties: { type: 'integer' }
      },
      listOfThreeCount: {
        type: 'integer',
        description: '콤마/쉼표/"와"/"이나"로 3개 이상 묶은 나열 문장 수. 반드시 0 (규칙 8, AI 시그니처)'
      },
      consecutiveNounSubjectMax: {
        type: 'integer',
        description: '명사 주어로 시작하는 문장의 최대 연속 개수. 2 이하 (규칙 9)'
      },
      shortSentenceRatio: {
        type: 'number',
        description: '15자 이하 단문 수 / 전체 문장 수. 0.20 이상 (P2)'
      },
      hedgeRatio: {
        type: 'number',
        description: '추정 어미("~인 것 같다","~라고 생각한다","~던 것 같다") 사용 문장 / 전체 문장. 0.10 이상 0.15 이하 (규칙 5)'
      },
      selfCheckPass: {
        type: 'boolean',
        description: '위 5개 임계를 전부 통과했을 때만 true. 하나라도 위반이면 false'
      }
    },
    required: [
      'outputText', 'summary', 'detail',
      'topNounCounts', 'listOfThreeCount', 'consecutiveNounSubjectMax',
      'shortSentenceRatio', 'hedgeRatio', 'selfCheckPass'
    ]
  }
};

const DETECT_TOOL = {
  name: 'return_detection_result',
  description: 'AI 생성 확률 판정 결과를 반환한다.',
  input_schema: {
    type: 'object',
    properties: {
      probability: { type: 'number', description: '0~100 사이 AI 생성 확률' },
      summary:     { type: 'string', description: '핵심 판단 이유 1~2문장' },
      detail:      { type: 'string', description: '상세 분석 100자 이상' }
    },
    required: ['probability', 'summary', 'detail']
  }
};

function extractToolResult(data, toolName) {
  const toolUse = data.content && data.content.find(c => c.type === 'tool_use' && c.name === toolName);
  if (!toolUse) throw new Error('모델이 구조화 응답을 반환하지 않았습니다.');
  return toolUse.input;
}

// 셀프체크 수치를 임계와 대조해 위반된 항목을 사람이 읽을 문장으로 반환
function collectFailedFields(r) {
  const failed = [];
  if (r.topNounCounts && Object.values(r.topNounCounts).some(n => n >= 4)) {
    const over = Object.entries(r.topNounCounts).filter(([, n]) => n >= 4).map(([k, n]) => `"${k}" ${n}회`).join(', ');
    failed.push(`주제어 4회 이상 반복(규칙 7): ${over} — 지시어/유의어로 교체`);
  }
  if (r.listOfThreeCount >= 1) {
    failed.push(`3개 이상 나열 ${r.listOfThreeCount}건(규칙 8, AI 시그니처) — 별도 문장으로 분리`);
  }
  if (r.consecutiveNounSubjectMax >= 3) {
    failed.push(`명사 주어 ${r.consecutiveNounSubjectMax}연속(규칙 9) — 중간 문장을 부사/접속사/지시어로 시작`);
  }
  if (typeof r.shortSentenceRatio === 'number' && r.shortSentenceRatio < 0.20) {
    failed.push(`15자 이하 단문 비율 ${(r.shortSentenceRatio * 100).toFixed(0)}%(P2, 목표 20%+) — 긴 문장을 쪼개라`);
  }
  if (typeof r.hedgeRatio === 'number' && (r.hedgeRatio < 0.10 || r.hedgeRatio > 0.15)) {
    failed.push(`추정 어미 비율 ${(r.hedgeRatio * 100).toFixed(0)}%(규칙 5, 목표 10~15%) — 조정`);
  }
  return failed;
}

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

async function callClaude(messages, tools, temperature, system, options = {}) {
  const body = {
    model: options.model || MODEL,
    max_tokens: options.maxTokens || 8192,
    messages: messages
  };

  if (tools) body.tools = tools;
  if (options.toolChoice) body.tool_choice = options.toolChoice;
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

  if (data.stop_reason === 'max_tokens') {
    console.log('⚠️ 응답이 max_tokens 제한으로 잘림');
  }

  return data;
}

// --- 라우트 ---

router.post('/analyze', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] /analyze 요청 IP: ${ip}`);
  try {
    const { mode, text } = req.body;
    const lang = req.body.lang || 'ko';
    if (!text || text.length < 5) return res.json({ error: '텍스트가 너무 짧습니다.' });

    // ★ 감지: tool_use로 구조화 응답 수신 (JSON.parse 실패 원천 차단)
    if (mode === 'detect') {
      const data = await callClaude(
        [{ role: 'user', content: `[분석할 글]\n${text}` }],
        [DETECT_TOOL], undefined,
        getDetectSystem(lang),
        { model: MODEL, maxTokens: 1024, toolChoice: { type: 'tool', name: DETECT_TOOL.name } }
      );
      const result = extractToolResult(data, DETECT_TOOL.name);
      return res.json({ ok: true, result, usage: data.usage });
    }

    // 웹 검색 (유저가 활성화한 경우에만 실행)
    let examples = null;
    if (req.body.webSearch) {
      try {
        const searchPrompt = lang === 'en'
          ? `Identify the topic of the following text and briefly provide 2-3 specific real-world examples or statistics related to it. Text: ${text.substring(0, 500)}`
          : `다음 글의 주제를 파악하고, 관련된 구체적인 실제 사례나 통계를 2~3개 간략히 제시해줘. 글: ${text.substring(0, 500)}`;
        const searchData = await callClaude(
          [{ role: 'user', content: searchPrompt }],
          [{ type: 'web_search_20250305', name: 'web_search' }]
        );
        const textContent = searchData.content.filter(c => c.type === 'text').map(c => c.text).join('');
        if (textContent.length > 50) examples = textContent.substring(0, 800);
      } catch(e) {}
    }

    // ★ 휴머나이저: 고정 프롬프트는 system(캐싱), 유저 텍스트만 user 메시지
    const selectedMode = req.body.humanizeMode || 'assignment';
    const humanizeSystem = getHumanizeSystem(selectedMode, lang);
    const userContent = examples
      ? `[재작성할 텍스트]\n${text}\n\n[참고할 실제 사례/통계 (자연스럽게 녹여 활용)]\n${examples}`
      : `[재작성할 텍스트]\n${text}`;
    const data = await callClaude(
      [{ role: 'user', content: userContent }],
      [HUMANIZE_TOOL], 0.9,
      humanizeSystem,
      { maxTokens: 16384, toolChoice: { type: 'tool', name: HUMANIZE_TOOL.name } }
    );
    let result = extractToolResult(data, HUMANIZE_TOOL.name);

    // ★ 2-pass 폴백: selfCheckPass=false일 때만 위반 항목을 명시해 재수정
    let refineUsage = null;
    if (result.selfCheckPass === false) {
      const failed = collectFailedFields(result);
      console.log(`⚠️ selfCheckPass=false, 2-pass 폴백 실행. 위반: ${failed.join(' | ')}`);
      const refineUser = `[이전 출력]\n${result.outputText}\n\n[위반 항목]\n${failed.join('\n')}\n\n위반된 부분만 최소 수정하라. 다른 문장은 그대로 유지. 수정 후 체크리스트 수치를 실제로 다시 세서 채워라.`;
      const refineData = await callClaude(
        [{ role: 'user', content: refineUser }],
        [HUMANIZE_TOOL], 0.9,
        humanizeSystem,
        { maxTokens: 16384, toolChoice: { type: 'tool', name: HUMANIZE_TOOL.name } }
      );
      result = extractToolResult(refineData, HUMANIZE_TOOL.name);
      refineUsage = refineData.usage;
      if (result.selfCheckPass === false) {
        console.log(`⚠️ 2-pass 후에도 selfCheckPass=false. 결과 그대로 반환.`);
      }
    }

    if (result.outputText) result.outputText = cleanText(result.outputText);

    res.json({ ok: true, result, usage: data.usage, refineUsage });

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
    const lang = req.body.lang || 'ko';
    const pdfData = await pdfParse(req.file.buffer);
    const text = pdfData.text.trim();
    if (!text || text.length < 5) return res.json({ error: 'PDF에서 텍스트를 추출할 수 없습니다.' });

    const systemPrompt = mode === 'detect' ? getDetectSystem(lang) : getHumanizeSystem(req.body.humanizeMode || 'assignment', lang);
    const userContent = mode === 'detect' ? `[분석할 글]\n${text}` : `[재작성할 텍스트]\n${text}`;
    const activeTool = mode === 'detect' ? DETECT_TOOL : HUMANIZE_TOOL;
    const pdfOptions = mode === 'detect'
      ? { model: MODEL, maxTokens: 1024, toolChoice: { type: 'tool', name: DETECT_TOOL.name } }
      : { maxTokens: 16384, toolChoice: { type: 'tool', name: HUMANIZE_TOOL.name } };
    const data = await callClaude(
      [{ role: 'user', content: userContent }],
      [activeTool], undefined,
      systemPrompt,
      pdfOptions
    );
    const result = extractToolResult(data, activeTool.name);
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
