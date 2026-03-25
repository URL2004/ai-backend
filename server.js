const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const rateLimit = require('express-rate-limit');

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
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('허용되지 않은 접근입니다.'));
  }
}));
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: '요청이 너무 많습니다.' }
});
app.use('/analyze', limiter);

const upload = multer({ storage: multer.memoryStorage() });
const API_KEY = process.env.ANTHROPIC_API_KEY;

function safeJsonParse(str) {
  try {
    const cleaned = str.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    const jsonMatch = str.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (innerE) {
        throw new Error("JSON 형식이 올바르지 않습니다.");
      }
    }
    throw new Error("응답에서 데이터를 찾을 수 없습니다.");
  }
}

function getHumanizePrompt(text, examples, level) {
  const exampleSection = examples ? `\n### 참고 사례\n${examples}\n` : '';

  return `당신은 AI 탐지기를 완벽하게 우회하는 인간 작가입니다. 다음 6단계 원칙을 엄격히 준수하세요.

### 핵심 재작성 원칙:

1. **로그 확률(Log Probability) 파쇄**
    - AI가 예측하기 쉬운 정석적인 단어 조합을 피할 것
    - 예) "강력한 동기부여가 되었습니다" → "부정적인 얘기를 들을 때가 많았습니다"
    - 전문 한자어보다 일상적이고 구체적인 순우리말 표현 사용
    - "치명적 한계에 봉착" → "한계에 부딪혀서 사실상 포기하려고 했습니다."

2. **Perplexity(혼란도) 주입**
    - 문장이 너무 완벽하고 딱딱하게 끝나지 않도록 추측성 어미나 사고 과정 노출
    - 예) "증명하는 상징적 사건입니다" → "보여준 일이라고 생각합니다"
    - 30~40% 문장에 "~인 것 같습니다", "~라고 생각합니다", "~던 것 같습니다" 삽입

3. **지그재그 리듬 (문장 길이 동적 조절)**
    - 아주 긴 호흡의 문장 뒤에는 반드시 5~20자 내외의 짧은 문장 배치
    - 예) "...복잡한 요인들이 얽혀 있어 쉽게 해결하기 어렵다는 점을 알게 됐습니다." → 그 이후 많은 생각을 하게 되었습니다.와 같은 문장
    - 최소 3회 이상 적용

4. **어휘 수준 의도적 하향 + N-gram Break**
    - 한자어/고급 표현을 순우리말로 교체
    - 3~4어절마다 "사실적으로", "어쩌면", "추가적인", "주도적인", "집약적인", "객관적인", "실질적인", "명확한", "전략적인", "효율적인", "심층적인", "지속적인", "독창적인", "유의미하게", "추가적으로", "주도적으로", "집약적으로", "객관적으로", "주관으로", "실질적으로", "다방면에서", "명확하게", "전략적으로", "효율적으로" "꾸준히" "끊임없이" "적극적으로" "성공적으로" "원활하게" "묵묵히" "따라서" "그러므로" "결론적으로" "종합적으로" "구체적이게" 중에서 부사 삽입
    - 위 단어들의 어미는 문장에 맞게 수정 가능함

5. **자연스러운 추임새**
    - "사실", "막상", "왜인지" "돌이켜보면" "어떤 면에서 보면" "새삼" "오보는히려" "어쩌면" "단순히" "결국"같은 표현 1~2개 삽입
    - 문단 순서를 논리 흐름이 깨지지 않는 선에서 일부 변경
    
6. **어휘 의도적 변경 + N-gram Break**
    - 문장을 "요"로 끝내지 않기.
    - 문장을 "습니다" 와 같은 존댓말인 "다" 로 끝내기
    - "생각해보면" 과 같은 너무 추상적인 부사 사용 금지
    
7. **어색한 부수적인 수식어나 불필요한 연결 문구 삭제**
    - 핵심 위주로 문장을 간결하게 작성
${exampleSection}
### 작업 지침:
- 원문 핵심 의미 유지, 문장 구조와 단어 선택은 90% 이상 새롭게 변경
- 원문 문체(~이다/~했다/~습니다) 반드시 유지, 문체 변환 금지
- 마침표(.) 뒤 반드시 띄어쓰기

### 재작성할 텍스트:
"${text}"

JSON 응답: {"outputText":"변환된 글 전체","summary":"요약","detail":"적용 기법 상세"}`;
}

app.post('/analyze', async (req, res) => {
  try {
    const { mode, text } = req.body;
    if (!text || text.length < 5) return res.json({ error: '텍스트가 너무 짧습니다.' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'x-api-key': API_KEY, 
        'anthropic-version': '2023-06-01' 
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 8192,
        messages: [{ role: 'user', content: getHumanizePrompt(text, null, req.body.level) }]
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      return res.json({ error: errorData.error?.message || 'Claude API 통신 실패' });
    }

    const data = await response.json();
    const contentText = data.content[0].text;

    try {
      const resultJson = safeJsonParse(contentText);
      res.json({ ok: true, result: resultJson });
    } catch (parseErr) {
      res.json({ error: "해석 실패: " + parseErr.message });
    }

  } catch (err) {
    res.json({ error: '서버 오류: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('서버 수정 완료!'));
