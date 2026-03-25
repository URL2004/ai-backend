const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);

// [원본 유지] 허용 도메인
const allowedOrigins = [
  'https://gpkorea.ai.kr',
  'https://www.gpkorea.ai.kr',
  'http://localhost:3000',
  'http://127.0.0.1:5500'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('허용되지 않은 접근입니다.'));
  }
}));
app.use(express.json({ limit: '10mb' }));

// [원본 유지] Rate Limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: '요청이 너무 많습니다.' }
});
app.use('/analyze', limiter);

const upload = multer({ storage: multer.memoryStorage() });
const API_KEY = process.env.ANTHROPIC_API_KEY;

// [복구] 사용자님의 핵심 6단계 휴머나이즈 프롬프트
function getHumanizePrompt(text, examples, level) {
  return `당신은 AI 탐지기를 완벽하게 우회하는 인간 작가입니다. 다음 6단계 원칙을 엄격히 준수하세요.

### 핵심 재작성 6원칙 (절대 누락 금지):

1. **로그 확률(Log Probability) 파쇄**
   - AI가 예측하기 쉬운 정석적인 단어 조합을 완전히 피할 것.
   - 전문 한자어 대신 일상적이고 구체적인 순우리말 표현 사용. 
   - 예) "치명적 한계에 봉착" -> "한계에 부딪혀서 사실상 포기하려던 참이었습니다."

2. **Perplexity(혼란도) 주입**
   - 문장이 너무 완벽하게 끝나지 않도록 인간 특유의 사고 과정 노출.
   - 30~40% 문장에 "~인 것 같습니다", "~라고 생각합니다", "~던 것 같습니다" 삽입.

3. **지그재그 리듬 (문장 길이의 동적 변동)**
   - 아주 긴 호흡의 문장(40자 이상) 뒤에는 반드시 5~15자 내외의 짧은 문장 배치.
   - 예) "...해결하기 어렵다는 점을 알게 됐습니다. 딱 그랬습니다. 그래서 다시 시작했습니다." (최소 3회 적용)

4. **어휘 수준 의도적 하향 (인간미 부여)**
   - 지나치게 세련된 단어를 의도적으로 투박하게 교체. 
   - "불규칙한 데이터 패턴" -> "제멋대로인 데이터들" 식으로 구어체적 뉘앙스 추가.

5. **N-gram Break (예측 확률 파괴)**
   - 3~4어절마다 "그냥", "아예", "진짜", "사실", "어쩌면" 같은 부사를 삽입하여 AI의 다음 단어 예측 경로 차단.

6. **자연스러운 추임새 및 문단 재구성**
   - "솔직히 말하면", "생각해보면" 같은 표현 삽입.
   - 문단 순서를 인간의 의식 흐름처럼 자연스럽게 재배치.

### 작업 지침:
- 원문 의미는 유지하되 구조와 단어 선택은 90% 이상 새롭게 변경.
- 마침표(.) 뒤 반드시 띄어쓰기 엄수.

재작성할 텍스트: "${text}"

JSON 응답: {"outputText":"변환된 글 전체","summary":"요약","detail":"적용 기법 상세"}`;
}

// [원본 복구] 분석 API
app.post('/analyze', async (req, res) => {
  try {
    const { mode, text } = req.body;
    if (!text || text.length < 5) return res.json({ error: '텍스트가 너무 짧습니다.' });

    // Claude 호출 로직 (생략된 부분 없이 원본 그대로 유지)
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        messages: [{ role: 'user', content: getHumanizePrompt(text, null, req.body.level) }]
      })
    });
    const data = await response.json();
    res.json({ ok: true, result: JSON.parse(data.content[0].text) });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('서버 복구 완료!'));
