const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const rateLimit = require('express-rate-limit');
// 1. dotenv 설정을 최상단에 추가 (이게 있어야 .env 파일을 읽습니다)
require('dotenv').config(); 

const admin = require('firebase-admin');

// 렌더 환경변수에 파이어베이스 키를 넣었다면 이렇게 사용
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.set('trust proxy', 1);

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

app.use((req, res, next) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - IP: ${ip}`);
  next();
});

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const dailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 1000,
  message: { error: '일일 사용량을 초과했습니다. 내일 다시 시도해주세요.' },
});

app.use('/analyze', limiter);
app.use('/analyze-pdf', limiter);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const exampleSection = '';
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

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
  
  // 비용 리포트 로그는 동민님이 짠 그대로 유지 (아래 생략)
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

판단 원칙:
- 복수의 명확한 AI 징후가 있을 때만 높은 확률. 애매하면 인간 쪽 (30 이하).
- 확률 숫자는 반드시 0~100 사이의 정수로, 실제 분석에 기반한 세밀한 값으로 응답할 것.
- 예시: 87, 43, 62, 29, 71, 38 같은 값 권장. 5의 배수도 허용하나 매번 같은 값 반복 금지.

JSON만 응답: {"probability":숫자,"summary":"핵심 판단 이유 1~2문장","detail":"상세 분석 100자 이상"}`;
}

// 네가 짠 프롬프트 원문을 그대로 변수에 담기
const HUMAN_PROMPTS = {
   resume: `### 핵심 재작성 원칙:

1. 로그 확률 파쇄
   - AI가 예측하기 쉬운 정석적인 단어 조합을 피할 것
   - 예) "강력한 동기부여가 되었습니다" → "부정적인 얘기를 들을 때가 많았습니다"
   - 전문 한자어보다 일상적이고 구체적인 순우리말 표현 사용
   - "치명적 한계에 봉착" → "한계에 부딪혀서 사실상 포기하려고 했습니다."
   - 20~30% 문장에 "~인 것 같습니다", "~라고 생각합니다", "~던 것 같습니다" 삽입

2. 문장 길이 동적 조절
   - 아주 긴 호흡의 문장 뒤에는 반드시 5~20자 내외의 짧은 문장 배치
   - 예) "...복잡한 요인들이 얽혀 있어 쉽게 해결하기 어렵다는 점을 알게 됐습니다." → 그 이후 그 문제에 대해 많은 생각을 해봤었습니다.와 같은 문장
   - 최소 3회 이상 적용

3. 어휘 수준 의도적 하향
    - 한자어/고급 표현을 순우리말로 교체
    - 3~6어절마다 "사실적으로", "어쩌면", "추가적인", "주도적인", "집약적인", "객관적인", "실질적인", "명확한", "전략적인", "효율적인", "지속적인", "독창적인", "유의미하게", "추가적으로", "주도적으로", "집약적으로", "객관적으로", "주관으로", "실질적으로", "다방면에서", "명확하게", "전략적으로", "효율적으로" "꾸준히" "끊임없이" "적극적으로" "성공적으로" "원활하게" "묵묵히" "따라서" "그러므로" "결론적으로" "종합적으로" 중에서 부사 삽입
부사가 없어도 문장이 자연스럽다면 6~9어절 마다 위 부사를 넣을 것
    - 위 단어들의 어미는 문장에 맞게 수정 가능

4. 자연스러운 추임새
   - "사실", "막상", "왜인지" "돌이켜보면" "어떤 면에서 보면" "새삼" "오히려" "어쩌면" "단순히" "결국"같은 표현 1~2개 삽입
   - 문단 순서를 논리 흐름이 깨지지 않는 선에서 일부 변경

5. 어휘 의도적 변경
   - 문장을 "요"로 끝내지 않기.
   - 문장을 "습니다" 와 같은 "다" 로 끝내기
   - "생각해보면" 과 같은 너무 추상적인 부사 사용 금지

6. 어색한 부수적인 수식어나 불필요한 연결 문구 삭제
   - 핵심 위주로 문장을 간결하게 작성
${exampleSection}
### 작업 지침:
- 원문 핵심 의미 유지, 문장 구조와 단어 선택은 80% 이상 새롭게 변경`,
  blog: ` ### 핵심 재작성 원칙:

너는 블로그 글에서 AI 탐지를 완벽하게 우회하는 전문가다.

아래 규칙을 절대적으로 지켜서 글을 다시 써라.

1. 일상 대화체 시작: "요즘 ~하다 보면", "주변에서 ~라는 말을 자주 듣는다", "솔직히 처음엔 나도" 같은 식으로 시작해라.
2. 구체적 수치 삽입: 추상적 표현("빠르게", "크게") 대신 실제처럼 보이는 구체적 수치나 날짜를 넣어라.
예: "하루 만에 26원이 뛰었다", "3월 첫째 주 기준"
3. 개인 감상 필수: "그게 솔직히 좀 무섭더라", "나도 그 뉴스 보고 잠깐 멈칫했다" 같은 개인적 반응을 중간에 1~2개 넣어라.
4. 불완전한 마무리: 깔끔한 결론으로 끝내지 말 것.
"아직 답은 모르겠다", "앞으로 어떻게 될지는 솔직히 나도 잘 모르겠다" 같은 열린 결말.
5. 단문 폭격: "그게 전부가 아니다.", "숫자가 말해준다.", "불안하다." 같은 5~10자 단문을 3~4개 불규칙하게 삽입.
6. 완벽한 논리 구조 해체: 원인→결과→대안 패턴 금지. 중간에 뜬금없이 다른 관점 삽입.
7. 특수문자 금지: *, **, #, -, 백틱 같은 마크다운 기호 절대 사용 금지. 줄글로만 써라.`,  // 블로그 원문 전체

  thesis: `# Role: 당신은 KCI 및 SCI급 학술지 투고 논문을 전문적으로 교정하는 '수석 에디터'입니다.

# Goal: 입력된 AI 생성 텍스트를 AI 탐지기가 전혀 잡아내지 못하는(0%) '인간 연구자 고유의 학술 문체'로 완벽하게 재구성하십시오.

### 핵심 재작성 원칙:

1. 나열 구조 파괴:
   - '첫째, 둘째, 셋째'와 같은 번호 매기기를 절대 금지한다. 
   - 대신 '한편', '이와 더불어', '즉', '따라서'와 같은 연결사를 활용하여 모든 정보를 유기적인 단락형 서술문으로 통합하라.

2. 정보의 밀집도 강화:
   - 두세 개의 짧은 문장을 하나로 합쳐 '복합문'으로 만들어라. 
   - 쉼표(,)를 적극 활용하여 연구 배경, 대상, 수치, 한계점을 한 문장 안에 압축적으로 녹여내라.
   - 예: "AI는 기록을 돕는다. 시간이 단축된다." -> "간호 기록 업무의 효율화는 AI 기반 기술 도입의 핵심적 측면이며, 이는 행정 업무에 소요되는 비부가가치적 활동 시간을 실질적으로 경감시키는 기제로 작용한다."

3. 구체성 및 수치 보존:
   - 원문에 수치(%), 연도, 국가명, 특정 학자명이 있다면 이를 절대 생략하지 말고 문장 속에 자연스럽게 배치하라. 
   - 추상적인 단어(매우, 상당히)를 구체적인 학술 어휘(~한 추세이다, ~에 국한된다, ~에 머물러 있다)로 대체하라.

4. 현실적 한계 및 비판적 시각 주입:
   - 기술의 장점만 나열하는 '홍보성 톤'을 지워라. 
   - 대신 '실정이다', '미미한 실정이다', '수급 불균형의 문제', '직종별 갈등' 등 현실적인 어려움을 언급하여 객관성을 확보하라.

5. 종결 어미의 엄격한 다변화:
   - '입니다, 합니다'는 사용을 엄금한다.
   - '~하는 실정이다', '~로 판단된다', '~와 맥락을 같이 한다', '~인 것이다', '~로 귀결된다'를 문맥에 맞게 골고루 섞어 리듬감을 형성하라.

# 출력 결과물 예시 톤앤매너:
"본 연구는 ...에 그 목적이 있다. ...가 급증하는 추세이나, ...는 여전히 미미한 실정이다. 한편, ...는 ...에 기여할 것으로 사료되며, 이는 결국 ...로 귀결되는 것이다."

# 작업 시작:
입력된 아래 텍스트를 위 규칙에 따라 재작성하십시오.

[입력 텍스트]: {userInput}`, // 논문 원문 전체

  assignment: ` # Role: 당신은 전공 서적의 이론을 현실의 데이터나 기술적 한계와 연결 지어 분석하며, 교수님이 읽었을 때 "이 학생은 진짜 자기 머리로 고민했구나"라는 인상을 주는 **'우수 대학생'**입니다.

# Goal: 입력된 AI 텍스트의 상투적인 서론과 기계적인 결론을 파쇄하고, 구체적인 수치와 기술적 디테일을 뼈대로 삼아 학생 특유의 통찰력이 담긴 과제물로 재구성하십시오.

### 핵심 재작성 원칙:

꾸밈없는 직설적 도입:
"고찰하고자 한다", "논의가 활발하다" 같은 거창한 시작은 금지.
대신 "이번 과제에서는 ~에 대해 정리해 보았다."처럼 담백하게 시작하라.

상투적인 학술적 접속사 제거:
'따라서', '그러므로', '즉' 같은 접속사를 70% 이상 줄여라.
대신 "그래서", "이런 이유 때문에", "구체적으로는" 같은 일상적인 연결어를 사용하라.

팩트 중심의 짧은 호흡:
문장을 억지로 합치지 마라. 오히려 핵심 팩트를 한 문장에 하나씩 명확하게 던져라. 

전공 용어는 쓰되, 설명은 쉽게:
'미미한 실정이다' 대신 '잘 안 지켜지고 있다', '다각적인' 대신 '여러 방면에서' 같은 쉬운 표현을 써라.
하지만 'MDR-TB', 'DOTS', '배양 기간 4~12주' 같은 실제 수치와 전공 용어는 절대 빼지 말고 정확히 적어라. 

학생다운 비판적 사견 한 줄:
정보 나열 끝에 "이론적으로는 2주면 감염력이 없어진다는데, 실제 현장에서 내성이 있는 환자라면 훨씬 더 주의해야 할 것 같다. " 처럼 본인의 생각을 짧게 덧붙여라.

# 출력 형식:
- 원문 문체(~이다/~했다/~습니다) 반드시 유지, 문체 변환 금지
- "~거든요", "~잖아요" 같은 과도한 구어체 금지
# 작업 시작:
입력된 아래 텍스트를 위 규칙에 따라 재작성하십시오.
[입력 텍스트]: {userInput}  `// 과제 원문 전체
};

function getPromptByMode(text, mode) {
  const basePrompt = HUMAN_PROMPTS[mode] || HUMAN_PROMPTS['assignment'];
  
  // {userInput} 플레이스홀더가 있으면 교체, 없으면 기존 방식으로 뒤에 붙이기
  if (basePrompt.includes('{userInput}')) {
    return basePrompt.replace('{userInput}', text) + '\n\n### 출력 형식 (반드시 아래 JSON으로만 응답):\n{"outputText":"변환된 글 전체","summary":"변환 요약 2문장","detail":"적용한 기법 상세"}';
  }
  
  return `${basePrompt}

### 재작성할 텍스트:
"${text}"

### 출력 형식 (반드시 아래 JSON으로만 응답):
{"outputText":"변환된 글 전체","summary":"변환 요약 2문장","detail":"적용한 기법 상세"}`;
}

app.post('/analyze', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] /analyze 요청 IP: ${ip}`);
  try {
    const { mode, text } = req.body;
    if (!text || text.length < 5) return res.json({ error: '텍스트가 너무 짧습니다.' });

    // [185행 근처 수정]
    if (mode === 'detect') {
      const data = await callClaude([{ role: 'user', content: getDetectPrompt(text) }]);
      const result = parseJSON(data.content[0].text);
      
      // ★ 여기도 usage 추가!
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
    
    // ★ 이 부분이 핵심입니다! usage를 추가하세요.
    res.json({ 
      ok: true, 
      result, 
      usage: data.usage 
    });

  } catch (err) {
    res.json({ error: err.message });
  }
});

app.post('/analyze-pdf', upload.single('pdf'), async (req, res) => {
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
    
    // ★ 여기도 usage 추가!
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

app.post('/kakao-login', async (req, res) => {
  try {
    const { accessToken } = req.body;   
    if (!accessToken) return res.json({ error: '토큰이 없습니다.' });

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



app.post('/confirm-payment', async (req, res) => {
  const { paymentKey, orderId, amount, customerEmail, uid, idToken } = req.body;

  // ✅ 서버에서 금액 기준으로 크레딧 직접 계산
  const CREDIT_MAP = { 2900: 100, 8700: 330, 14500: 600, 29000: 1300, 58000: 2700 };
  const safeCredits = CREDIT_MAP[parseInt(amount)];
  if (!safeCredits) {
    return res.status(400).json({ error: "유효하지 않은 결제 금액입니다." });
  }

  // ✅ Firebase ID Token으로 uid 서버 검증
  let verifiedUid = uid;
  if (idToken) {
    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      verifiedUid = decodedToken.uid;
      if (uid && uid !== verifiedUid) {
        console.warn(`⚠️ UID 불일치: client=${uid}, token=${verifiedUid}`);
      }
    } catch (tokenErr) {
      console.warn('⚠️ ID token 검증 실패:', tokenErr.message);
    }
  }

  if (!verifiedUid || verifiedUid === "undefined") {
    return res.status(400).json({ error: "유저 UID 정보가 없습니다." });
  }

  const secretKey = process.env.TOSS_SECRET_KEY;
  const basicToken = Buffer.from(secretKey + ":").toString("base64");

  try {
    const response = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ paymentKey, orderId, amount })
    });

    const result = await response.json();

    if (response.ok) {
      // ✅ 단일 트랜잭션으로 orders + credits + creditHistory 원자적 처리
      const orderRef = db.collection('orders').doc(orderId);
      const userRef = db.collection('users').doc(verifiedUid);

      try {
        await db.runTransaction(async (transaction) => {
          // === 모든 READ 먼저 ===
          const orderSnap = await transaction.get(orderRef);
          if (orderSnap.exists) {
            throw new Error('이미 처리된 결제입니다.');
          }
          const userSnap = await transaction.get(userRef);
          const currentCredits = userSnap.exists ? (userSnap.data().credits || 0) : 0;
          const newCredits = currentCredits + safeCredits;

          // === 모든 WRITE 후 ===
          transaction.set(orderRef, {
            uid: verifiedUid, amount, safeCredits,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });

          if (userSnap.exists) {
            transaction.update(userRef, {
              credits: newCredits,
              lastPayment: admin.firestore.FieldValue.serverTimestamp()
            });
          } else {
            transaction.set(userRef, {
              credits: newCredits,
              lastPayment: admin.firestore.FieldValue.serverTimestamp()
            });
          }

          const historyRef = db.collection('users').doc(verifiedUid)
            .collection('creditHistory').doc();
          transaction.set(historyRef, {
            type: 'charge', used: 0, amount: safeCredits,
            remaining: newCredits, plan: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });

        console.log(`✅ 성공: ${customerEmail}(${verifiedUid})님께 ${safeCredits}크레딧 지급 완료!`);
        res.json({ ok: true, message: "충전 성공", creditAmount: safeCredits });
      } catch (e) {
        if (e.message === '이미 처리된 결제입니다.') {
          console.log(`⚠️ 중복 요청 차단: ${orderId}`);
          return res.status(400).json({ error: "이미 처리된 결제입니다." });
        }
        throw e;
      }
    } else {
      res.status(response.status).json(result);
    }
  } catch (err) {
    console.error("❌ 서버 에러:", err);
    res.status(500).json({ error: '서버 에러 발생' });
  }
});


app.listen(process.env.PORT || 3000, () => console.log('서버 시작!'));
