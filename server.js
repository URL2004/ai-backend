const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

// 제로폭 문자 및 마침표 띄어쓰기 정리
function cleanText(text) {
  return text
    .replace(/[\u200B-\u200D\uFEFF\u00AD\u034F\u061C\u180E\u2000-\u200F\u2028-\u202F\u205F-\u206F]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\.([가-힣A-Za-z])/g, '. $1')
    .replace(/,([가-힣A-Za-z])/g, ', $1')
    .replace(/ {2,}/g, ' ')
    .trim();
}

async function callClaude(messages, tools) {
  const body = { model: MODEL, max_tokens: 8192, messages };
  if (tools) body.tools = tools;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
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

function getDetectPrompt(text) {
  return `당신은 AI가 작성한 글을 탐지하는 세계 최고 전문가입니다.

[분석할 글]
${text}

## AI 작성 징후
- 문장 길이가 균일하고 매끄러움
- "또한", "따라서", "이러한", "이를 통해" 접속어 과다
- "~할 수 있다", "~에 기여한다", "~하는 것이 중요하다"
- 완벽한 논리 전개 (문제→원인→해결→결론)
- 감정/주관 전혀 없는 중립적 서술

## 인간 작성 징후
- 불규칙한 문장 리듬, 단문과 장문 혼재
- 개인 감정, 경험, 주관적 의견
- 약간의 논리 비약이나 불완전한 문장
- 구어체 표현 혼용

판단 원칙: 복수의 명확한 AI 징후가 있을 때만 높은 확률. 애매하면 인간 쪽 (50 이하).

JSON만 응답: {"probability":숫자,"summary":"핵심 판단 이유 1~2문장","detail":"상세 분석 300자 이상"}`;
}

function getHumanizePrompt(text, examples) {
  const exampleSection = examples ? `\n## 주제 관련 실제 사례 (아래 중 자연스러운 것 1~2개 삽입)\n${examples}\n` : '';

  return `당신은 카피킬러 AI 탐지를 우회하는 전문가입니다. 아래 글을 사람이 쓴 것처럼 변환하세요.

[원문]
${text}
${exampleSection}
## 핵심 변환 전략 3가지 (모두 적용)

**전략 1: 완전한 패러프레이징**
모든 문장을 원문 그대로 쓰지 말고, 단어와 어순을 동시에 바꿀 것.
- 단어 교체: 원문 단어의 60% 이상을 유의어/다른 표현으로 교체
- 어순 변경: "A는 B다" → "B인 것이 바로 A다" 식으로 구조 변경
- 예) "소셜미디어는 현대인의 소통 창구다" → "요즘 사람들이 정보를 나누는 공간으로 소셜미디어가 자리 잡았다"
- 원문과 표현이 겹치는 문장이 있으면 안 됨

**전략 2: 문단 순서 재배치**
- 원문의 문단 순서를 논리 흐름이 크게 깨지지 않는 선에서 변경
- 본론 문단들의 순서를 바꾸거나, 결론 일부를 중간에 삽입
- 단, 서론/결론의 역할은 유지할 것

**전략 3: 짧은 표현 길게 풀어쓰기 + Burstiness 주입**
- 축약된 개념이나 짧은 표현을 구체적으로 풀어서 설명
- 예) "문제는 복잡하다" → "이 문제는 여러 요인이 한꺼번에 얽혀 있어 단순히 한 가지 원인만으로 설명하기 어렵다"
- 동시에 아주 짧은 문장(10자 이하) 2~3개를 자연스럽게 삽입
- 긴 문장과 짧은 문장이 불규칙하게 섞이게 할 것

## 추가 규칙
- Perplexity(혼란도) 높이기: 예측 가능한 단어 대신 덜 흔한 표현 사용
- 원문 문체(~이다/~했다/~습니다) 반드시 유지
- "사실", "생각해보면", "따지고 보면" 같은 자연스러운 표현 1~2개 허용
- "~거든요", "~잖아요" 같은 과도한 구어체 금지
- 마침표(.) 뒤 반드시 띄어쓰기, 쉼표(,) 뒤도 띄어쓰기
- 원문 핵심 주장과 내용 반드시 유지

JSON으로만 응답:
{"outputText":"변환된 글 전체","summary":"변환 요약 2문장","detail":"적용한 주요 기법"}`;
}

// AI 탐지
app.post('/analyze', async (req, res) => {
  try {
    const { mode, text } = req.body;
    if (!text || text.length < 5) return res.json({ error: '텍스트가 너무 짧습니다.' });

    if (mode === 'detect') {
      const data = await callClaude([{ role: 'user', content: getDetectPrompt(text) }]);
      const result = parseJSON(data.content[0].text);
      return res.json({ ok: true, result });
    }

    // 휴머나이저 - 웹 검색으로 사례 먼저 수집
    let examples = null;
    try {
      const searchData = await callClaude(
        [{ role: 'user', content: `다음 글의 주제를 파악하고, 관련된 구체적인 실제 사례나 통계를 2~3개 간략히 제시해줘. 글: ${text.substring(0, 500)}` }],
        [{ type: 'web_search_20250305', name: 'web_search' }]
      );
      const textContent = searchData.content.filter(c => c.type === 'text').map(c => c.text).join('');
      if (textContent.length > 50) examples = textContent.substring(0, 800);
    } catch(e) {
      // 검색 실패해도 계속 진행
    }

    const data = await callClaude([{ role: 'user', content: getHumanizePrompt(text, examples) }]);
    const result = parseJSON(data.content[0].text);
    if (result.outputText) result.outputText = cleanText(result.outputText);
    res.json({ ok: true, result });

  } catch (err) {
    res.json({ error: err.message });
  }
});

// PDF 분석
app.post('/analyze-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.json({ error: 'PDF 파일이 없습니다.' });
    const mode = req.body.mode || 'detect';
    const pdfData = await pdfParse(req.file.buffer);
    const text = pdfData.text.trim();
    if (!text || text.length < 5) return res.json({ error: 'PDF에서 텍스트를 추출할 수 없습니다.' });

    const prompt = mode === 'detect' ? getDetectPrompt(text) : getHumanizePrompt(text, null);
    const data = await callClaude([{ role: 'user', content: prompt }]);
    const result = parseJSON(data.content[0].text);
    if (result.outputText) result.outputText = cleanText(result.outputText);
    res.json({ ok: true, result, extractedText: text.substring(0, 500) });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('서버 시작!'));
