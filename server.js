const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

// 1. Firebase Admin 설정 (관리자 기능용)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}
const db = admin.firestore();

const app = express();
app.set('trust proxy', 1);

// [관리자 설정] 토스 심사용 UID
const ADMIN_UIDS = [
  'qa0iQAeVmMOxoy6Vg5ENTRKk0Vm2',
  'nC90IyjgaIZ8Z0JTABMTiyQHF9g1'
];

// Origin 검증
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

// Rate Limiting (기존 로직 그대로)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const dailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 100,
  message: { error: '일일 사용량을 초과했습니다. 내일 다시 시도해주세요.' },
});

app.use('/analyze', limiter, dailyLimiter);
app.use('/analyze-pdf', limiter, dailyLimiter);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

// [기존 함수 유지] 제로폭 문자 및 마침표 띄어쓰기 정리
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

// [기존 함수 유지] Claude API 호출
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

// [기존 함수 유지] JSON 파싱
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

// [기존 프롬프트 유지] AI 탐지 프롬프트
function getDetectPrompt(text) {
  return `당신은 AI가 작성한 글을 탐지하는 세계 최고 전문가입니다.\n\n[분석할 글]\n${text}\n\n## AI 작성 징후\n- 문장 길이가 균일하고 매끄러움\n- "또한", "따라서", "이러한", "이를 통해" 접속어 과다\n- "~할 수 있다", "~에 기여한다", "~하는 것이 중요하다"\n- 완벽한 논리 전개 (문제→원인→해결→결론)\n- 감정/주관 전혀 없는 중립적 서술\n\n## 인간 작성 징후\n- 불규칙한 문장 리듬, 단문과 장문 혼재\n- 개인 감정, 경험, 주관적 의견\n- 약간의 논리 비약이나 불완전한 문장\n- 구어체 표현 혼용\n\n판단 원칙: 복수의 명확한 AI 징후가 있을 때만 높은 확률. 애매하면 인간 쪽 (50 이하).\n\nJSON만 응답: {"probability":숫자,"summary":"핵심 판단 이유 1~2문장","detail":"상세 분석 300자 이상"}`;
}

// [기존 프롬프트 유지] 휴머나이저 프롬프트
function getHumanizePrompt(text, examples, level) {
  const lv = level || 2;
  const intensity = lv === 3 ? "매우 파격적이고 투박한" : lv === 1 ? "깔끔하고 정제된" : "자연스럽고 부드러운";
  const levelGuide = lv === 1 ? "- 문법 유지, 단어 교체" : lv === 3 ? "- 최대 강도 파격 수정" : "- 자연스러운 적용";
  const exampleSection = examples ? `\n### 참고 사례\n${examples}\n` : '';

  return `당신은 AI 탐지기를 완벽하게 우회하는 인간 작가입니다. 설정 강도: ${intensity}\n${levelGuide}\n${exampleSection}\n원문 의미 유지, 문체 유지, 마침표 뒤 띄어쓰기 필수.\n\n재작성할 텍스트: "${text}"\n\nJSON 응답: {"outputText":"변환된 글 전체","summary":"요약","detail":"상세"}`;
}

// --- 엔드포인트 ---

// [추가] 관리자 전용 데이터 조회
app.post('/admin/all-usage-history', async (req, res) => {
  try {
    const { adminUid } = req.body;
    if (!ADMIN_UIDS.includes(adminUid)) return res.status(403).json({ error: '권한 없음' });

    const snapshot = await db.collection('usageHistory').orderBy('timestamp', 'desc').limit(1000).get();
    const history = [];
    snapshot.forEach(doc => history.push({ id: doc.id, ...doc.data() }));
    res.json({ ok: true, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [기존 유지] 분석 엔드포인트
app.post('/analyze', async (req, res) => {
  try {
    const { mode, text } = req.body;
    if (!text || text.length < 5) return res.json({ error: '텍스트가 너무 짧습니다.' });

    if (mode === 'detect') {
      const data = await callClaude([{ role: 'user', content: getDetectPrompt(text) }]);
      const result = parseJSON(data.content[0].text);
      return res.json({ ok: true, result });
    }

    let examples = null;
    try {
      const searchData = await callClaude(
        [{ role: 'user', content: `주제 및 실제 사례 2~3개 제시: ${text.substring(0, 500)}` }],
        [{ type: 'web_search_20250305', name: 'web_search' }]
      );
      examples = searchData.content.filter(c => c.type === 'text').map(c => c.text).join('').substring(0, 800);
    } catch(e) {}

    const data = await callClaude([{ role: 'user', content: getHumanizePrompt(text, examples, req.body.level || 2) }]);
    const result = parseJSON(data.content[0].text);
    if (result.outputText) result.outputText = cleanText(result.outputText);
    res.json({ ok: true, result });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// [기존 유지] PDF 분석 엔드포인트
app.post('/analyze-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.json({ error: 'PDF 없음' });
    const pdfData = await pdfParse(req.file.buffer);
    const text = pdfData.text.trim();
    const prompt = (req.body.mode || 'detect') === 'detect' ? getDetectPrompt(text) : getHumanizePrompt(text, null);
    const data = await callClaude([{ role: 'user', content: prompt }]);
    const result = parseJSON(data.content[0].text);
    if (result.outputText) result.outputText = cleanText(result.outputText);
    res.json({ ok: true, result, extractedText: text.substring(0, 500) });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// [기존 유지] 카카오 로그인
app.post('/kakao-login', async (req, res) => {
  try {
    const { accessToken } = req.body;
    const userRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    const userData = await userRes.json();
    res.json({ 
      ok: true, 
      kakaoId: String(userData.id), 
      nickname: userData.kakao_account?.profile?.nickname,
      email: userData.kakao_account?.email || (userData.id + '@kakao.com'),
      photo: userData.kakao_account?.profile?.profile_image_url || ''
    });
  } catch(err) {
    res.json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Server started!'));
