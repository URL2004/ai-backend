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
      ? `당신은 AI가 작성한 글을 탐지하는 세계 최고 전문가입니다. 아래 글을 정밀 분석하세요.

[분석할 글]
${text}

## AI 작성 징후 (높은 확률)
- 문장 길이가 지나치게 균일함
- "~할 수 있습니다", "~을 통해", "~하는 것이 중요합니다", "~에 기여합니다" 등 AI 특유 표현 반복
- "또한", "따라서", "이러한", "이를 통해", "뿐만 아니라" 접속어 과다
- 완벽하게 균형 잡힌 논리 전개 (기승전결이 너무 깔끔)
- 감정/주관/개인 경험 전혀 없는 중립적 서술
- 단락 길이가 균일함
- 지나치게 포괄적이고 모범적인 내용

## 인간 작성 징후 (낮은 확률)
- 불규칙한 문장 리듬과 길이
- 개인적 감정, 경험, 주관적 의견 포함
- 약간의 문법적 비완벽성이나 구어체
- 논리의 비약이나 감정적 서술
- 특정 상황에 대한 구체적 묘사

## 판단 원칙
- 복수의 명확한 AI 징후가 있을 때만 높은 확률 부여
- 애매한 경우 반드시 인간 쪽으로 판단 (50 이하)
- 단순히 잘 쓴 글이라고 AI라고 판단하지 말 것

JSON만 응답 (다른 텍스트 절대 금지):
{"probability":숫자,"summary":"핵심 판단 이유 1~2문장","detail":"상세 분석 300자 이상"}`

      : `당신은 AI 탐지 시스템을 완벽하게 우회하는 세계 최고 전문가입니다.

[변환할 글]
${text}

## 핵심 목표
GPTZero, Turnitin, Copyleaks 등 모든 AI 탐지기에서 30% 이하로 나오게 변환

## 반드시 지켜야 할 규칙

**1. 원문 문체 완벽 유지 (가장 중요)**
- 원문이 "~이다/~했다/~된다" 체 → 반드시 그 문체 유지 (논문/레포트)
- 원문이 "~습니다/~입니다" 체 → 그 문체 유지 (자소서/공식문서)
- 원문이 "~해요/~어요" 체 → 그 문체 유지 (블로그/일상)
- 절대로 문체를 바꾸지 말 것. 논문을 구어체로 바꾸거나, 자소서를 반말로 바꾸지 말 것

**2. AI 냄새 제거**
- "또한", "따라서", "이러한", "이를 통해", "뿐만 아니라" 전면 삭제 또는 교체
- "~할 수 있습니다", "~을 통해", "~하는 것이 중요합니다" 표현 교체
- 완벽한 기승전결 구조 해체
- 단락 길이 불균일하게 조정

**3. 인간적 요소 삽입 (문체에 맞게)**
- 논문/레포트: 약간의 주관적 시각, 의문 제기, 구체적 사례 추가
- 자소서: 구체적 경험 묘사, 감정 표현, 개인적 동기 강조
- 블로그: 구어체 표현, 감탄사, 개인 의견 삽입

**4. 문장 구조 변화**
- 문장 길이 불규칙하게 (짧은 문장과 긴 문장 혼재)
- 일부 문장 도치 또는 강조 구조 사용
- 원문 핵심 내용과 의미 반드시 유지

JSON만 응답 (다른 텍스트 절대 금지):
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
