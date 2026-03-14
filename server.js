const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

app.post('/analyze', async (req, res) => {
  try {
    const { mode, text } = req.body;
    if (!text || text.length < 20) {
      return res.json({ error: '텍스트가 너무 짧습니다.' });
    }

    const isDetect = mode === 'detect';
    const prompt = isDetect
      ? `당신은 AI가 작성한 글을 탐지하는 최고 전문가입니다. 아래 글을 분석하세요.

[분석할 글]
${text}

## 탐지 기준
AI 작성 징후:
- 문장 길이가 균일하고 리듬이 일정함
- "~할 수 있습니다", "~을 통해", "~하는 것이 중요합니다" 등 AI 특유 표현
- "또한", "따라서", "이러한", "이를 통해" 등 접속어 과다 사용
- 지나치게 완벽하고 균형잡힌 논리 전개
- 감정이나 주관이 전혀 없는 중립적 서술
- 단락 길이가 균일함

인간 작성 징후:
- 불규칙한 문장 리듬
- 개인적 감정, 경험, 주관적 의견 포함
- 약간의 문법적 비완벽성
- 구어체 표현
- 논리의 비약이나 감정적 서술

## 판단 원칙
- 복수의 명확한 근거가 있을 때만 높은 확률 부여
- 애매한 경우 인간 쪽으로 판단 (50 이하)

JSON만 응답:
{"probability":숫자,"summary":"핵심 판단 이유 1~2문장","detail":"상세 분석 300자 이상"}`
      : `당신은 AI 탐지 시스템을 완벽하게 우회하는 세계 최고 전문가입니다.

[변환할 글]
${text}

## 핵심 목표
GPTZero, Turnitin, Copyleaks 등 모든 AI 탐지기에서 30% 이하로 나오게 변환

## 반드시 지켜야 할 규칙

**문체 유지**
- 원문이 "~이다", "~했다", "~된다" 체면 반드시 그 문체 유지
- "~요", "~습니다" 절대 사용 금지
- 논문/레포트 문체 그대로 유지하면서 AI 냄새만 제거

**구조 파괴**
- "또한", "따라서", "이러한", "이를 통해", "뿐만 아니라" 전면 삭제
- 완벽한 기승전결 구조 해체
- 단락 길이 불균일하게 (어떤 건 1문장, 어떤 건 4문장)
- 문장 길이 불규칙하게 (짧은 문장과 긴 문장 혼재)

**인간적 요소 삽입**
- 약간의 주관적 시각 ("사실 이 부분은", "흥미롭게도", "생각해보면")
- 불완전한 논리나 의문 제기
- 구체적 사례나 디테일 추가
- 약간의 감정적 뉘앙스

**표현 교체**
- "~할 수 있다" → "~한다", "~하기도 한다"
- "~하는 것이 필요하다" → 삭제하거나 완전히 다르게
- "~에 걸쳐" → "~에서", "~동안"
- "긍정적인 효과" → 구체적 표현으로 교체

원문 핵심 내용과 의미는 반드시 유지할 것

JSON만 응답:
{"outputText":"변환된 글 전체","summary":"변환 요약 2~3문장","detail":"변환 포인트 설명"}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (data.error) return res.json({ error: data.error.message });

    const raw = data.content[0].text;
    const clean = raw.replace(/```json|```/g, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) return res.json({ error: '파싱 실패' });
    const result = JSON.parse(match[0]);
    res.json({ ok: true, result });

  } catch (err) {
    res.json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('서버 시작!');
});
