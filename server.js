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
      ? 'AI 탐지 전문가입니다.\n\n[분석할 글]\n' + text + '\n\n판단 원칙: 애매하면 인간 쪽으로 판단 (확률 50 이하)\n\nJSON만 응답: {"probability":숫자,"summary":"핵심 판단 이유 1~2문장","detail":"상세 분석 300자 이상"}'
      : 'AI 탐지 우회 전문가입니다. 아래 글을 사람이 쓴 것처럼 변환하세요.\n\n[변환할 글]\n' + text + '\n\n변환 규칙:\n- 원문의 문체(~이다/~했다 등) 반드시 유지\n- 문장 길이 불규칙하게 섞기\n- "~할 수 있습니다" "~을 통해" "또한" "따라서" "이러한" 전면 제거\n- 지나치게 완벽한 논리 구조 해체\n- 약간의 주관적 시각이나 의문 삽입\n- 원문 핵심 내용 반드시 유지\n\nJSON만 응답: {"outputText":"변환된 글 전체","summary":"변환 요약 2~3문장","detail":"변환 포인트 설명"}';

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
