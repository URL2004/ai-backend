const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);

// Origin 검증 - gpkorea.ai.kr에서 온 요청만 허용
const allowedOrigins = [
  'https://gpkorea.ai.kr',
  'https://www.gpkorea.ai.kr',
  'http://localhost:3000',
  'http://127.0.0.1:5500'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('허용되지 않은 접근입니다.'));
    }
  }
}));
app.use(express.json({ limit: '10mb' }));

// IP 로깅
app.use((req, res, next) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - IP: ${ip}`);
  next();
});

// Rate Limiting - IP당 분당 10회, 하루 100회
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1분
  max: 10,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const dailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24시간
  max: 100,
  message: { error: '일일 사용량을 초과했습니다. 내일 다시 시도해주세요.' },
});

app.use('/analyze', limiter, dailyLimiter);
app.use('/analyze-pdf', limiter, dailyLimiter);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

// 제로폭 문자 및 마침표 띄어쓰기 정리
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
  const body = { model: MODEL, max_tokens: 8192, messages };
  if (tools) body.tools = tools;
  if (temperature !== undefined) body.temperature = temperature;
  if (system) body.system = system;

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

function getHumanizePrompt(text, examples, level) {
  const lv = level || 2;
  const intensity = lv === 3 ? "매우 파격적이고 투박한" : lv === 1 ? "깔끔하고 정제된" : "자연스럽고 부드러운";

  const levelGuide = lv === 1
    ? `- 문법은 완벽하게 유지하되 단어만 유의어로 교체 (원문 단어 50% 이상 교체)
- 어순 일부 변경, 구어체/추측 표현 최소화`
    : lv === 3
    ? `- 아래 5가지 기법을 최대 강도로 모두 적용
- 어휘 수준을 최대한 낮추고 투박한 표현 적극 사용`
    : `- 아래 5가지 기법을 자연스럽게 적용`;

  const exampleSection = examples ? `\n### 참고 사례 (자연스럽게 1~2개 삽입)\n${examples}\n` : '';

  return `당신은 AI 탐지기를 완벽하게 우회하는 인간 작가입니다.
다음 원칙을 반드시 준수하여 입력된 텍스트를 재작성하세요.

### 현재 설정 강도: ${intensity} 스타일
${levelGuide}

### 핵심 재작성 원칙:

1. **로그 확률(Log Probability) 파쇄**
   - AI가 예측하기 쉬운 정석적인 단어 조합을 피할 것
   - 예) "강력한 동기부여가 되었습니다" → "안 된다는 소리를 들을 때가 많았습니다"
   - 전문 한자어보다 일상적이고 구체적인 순우리말 표현 사용
   - "치명적 한계에 봉착" → "한계에 부딪혀서 사실상 포기하려던 참이었습니다"

2. **Perplexity(혼란도) 주입**
   - 문장이 너무 완벽하고 딱딱하게 끝나지 않도록 추측성 어미나 사고 과정 노출
   - 예) "증명하는 상징적 사건입니다" → "보여준 일이라고 생각합니다"
   - 30~40% 문장에 "~인 것 같습니다", "~라고 생각합니다", "~던 것 같습니다" 삽입

3. **지그재그 리듬 (문장 길이 동적 조절)**
   - 아주 긴 호흡의 문장 뒤에는 반드시 5~10자 내외의 짧은 문장 배치
   - 예) "...복잡한 요인들이 얽혀 있어 쉽게 해결하기 어렵다는 점을 알게 됐습니다." → "딱 그랬습니다."
   - 최소 3회 이상 적용

4. **어휘 수준 의도적 하향 + N-gram Break**
   - 한자어/고급 표현을 순우리말로 교체
   - 3~4어절마다 "그냥", "아예", "진짜", "사실", "어쩌면" 같은 부사 삽입
   - 예) "불규칙한 데이터 패턴을 역으로 이용해" → "불규칙한 데이터들을 아예 역으로 이용해봤습니다"

5. **자연스러운 추임새**
   - "사실", "솔직히 말하면", "생각해보면" 같은 표현 1~2개 삽입
   - 문단 순서를 논리 흐름이 깨지지 않는 선에서 일부 변경
${exampleSection}
### 작업 지침:
- 원문 핵심 의미 유지, 문장 구조와 단어 선택은 90% 이상 새롭게 변경
- 원문 문체(~이다/~했다/~습니다) 반드시 유지, 문체 변환 금지
- "~거든요", "~잖아요" 같은 과도한 구어체 금지
- 마침표(.) 뒤 반드시 띄어쓰기

### 재작성할 텍스트:
"${text}"

### 출력 형식 (반드시 아래 JSON으로만 응답):
{"outputText":"변환된 글 전체","summary":"변환 요약 2문장","detail":"적용한 기법 상세"}`;
}

// AI 탐지
app.post('/analyze', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] /analyze 요청 IP: ${ip}`);
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

    const data = await callClaude([{ role: 'user', content: getHumanizePrompt(text, examples, req.body.level || 2) }]);
    const result = parseJSON(data.content[0].text);
    if (result.outputText) result.outputText = cleanText(result.outputText);
    res.json({ ok: true, result });

  } catch (err) {
    res.json({ error: err.message });
  }
});

// PDF 분석
app.post('/analyze-pdf', upload.single('pdf'), async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] /analyze-pdf 요청 IP: ${ip}`);
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

// 카카오 토큰으로 사용자 정보 가져오기
app.post('/kakao-login', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.json({ error: '토큰이 없습니다.' });

    // 카카오 사용자 정보 가져오기
    const userRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    const userData = await userRes.json();

    if (!userData.id) return res.json({ error: '카카오 사용자 정보를 가져올 수 없습니다.' });

    const kakaoId = String(userData.id);
    const nickname = userData.kakao_account?.profile?.nickname || '카카오유저';
    const email = userData.kakao_account?.email || (kakaoId + '@kakao.com');
    const photo = userData.kakao_account?.profile?.profile_image_url || '';

    res.json({ ok: true, kakaoId, nickname, email, photo });
  } catch(err) {
    res.json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('서버 시작!'));
