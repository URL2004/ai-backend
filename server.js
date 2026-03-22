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

async function callClaude(prompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 16000, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  const raw = data.content[0].text;
  const clean = raw.replace(/```json|```/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('파싱 실패: ' + raw.substring(0, 200));
  return JSON.parse(match[0]);
}

function getDetectPrompt(text) {
  return `당신은 AI가 작성한 글을 탐지하는 세계 최고 전문가입니다.

[분석할 글]
${text}

## AI 작성 징후
- 문장 길이가 균일함
- "~할 수 있습니다", "~을 통해", "~하는 것이 중요합니다" 등 AI 특유 표현
- "또한", "따라서", "이러한", "이를 통해" 접속어 과다
- 완벽하게 균형 잡힌 논리 전개
- 감정/주관 전혀 없는 중립적 서술

## 인간 작성 징후
- 불규칙한 문장 리듬
- 개인적 감정, 경험, 주관적 의견
- 약간의 문법적 비완벽성
- 논리의 비약이나 감정적 서술

## 판단 원칙
- 복수의 명확한 AI 징후가 있을 때만 높은 확률 부여
- 애매하면 인간 쪽으로 판단 (50 이하)

JSON만 응답: {"probability":숫자,"summary":"핵심 판단 이유 1~2문장","detail":"상세 분석 300자 이상"}`;
}

function getHumanizePrompt(text) {
  return `당신은 카피킬러, GPTZero, Turnitin 등 모든 AI 탐지기를 완벽하게 우회하는 세계 최고 전문가입니다.

[변환할 글]
${text}

## 최우선 목표: 카피킬러 AI 탐지 0% 달성

## 카피킬러가 잡는 패턴 (반드시 모두 제거)
- 문장 길이가 비슷하게 반복되는 패턴
- "또한", "따라서", "이러한", "이를 통해", "뿐만 아니라", "이와 같이", "위와 같이" 접속어
- "~할 수 있다", "~에 기여한다", "~하는 것이 중요하다", "~을 통해 알 수 있다"
- 단락마다 균일한 구조 (주장-근거-결론 반복)
- 지나치게 완벽한 맞춤법과 문법
- 모든 단락의 시작이 주제문으로 시작하는 패턴

## 문체 완벽 유지 (절대 규칙)
- 원문 종결어미 그대로: ~이다/~했다/~된다 → 그대로 유지
- ~습니다/~입니다 체 → 그대로 유지
- 절대 문체 바꾸지 말 것
- "~요", "~죠", "~네요" 구어체 삽입 금지
- 자문자답 금지

## 변환 기법 (모두 적용)
1. **문장 길이 파괴**: 짧은 문장(5~10자)과 긴 문장(50~80자) 불규칙하게 섞기
2. **단락 구조 해체**: 단락 길이를 1~5문장으로 불규칙하게
3. **접속어 교체**: "또한" → 삭제 또는 "게다가", "아울러", "더불어" 중 하나로 최소한만 사용
4. **표현 구체화**: 추상적 표현을 구체적 수치/사례/경험으로 교체
5. **의문 삽입**: 가끔 "~일까?", "~인지 생각해볼 필요가 있다" 같은 표현 삽입
6. **불완전성 추가**: 완벽한 논리 구조 대신 약간의 비약이나 주관 삽입
7. **어휘 다양화**: 같은 단어 반복 사용 금지, 유의어로 교체
8. **도치/강조**: 일부 문장 어순 변경으로 강조 효과

## 절대 유지사항
- 원문의 핵심 주장과 내용 100% 유지
- 원문 분량의 90~110% 유지

반드시 아래 JSON 형식으로만 응답:
{"outputText":"변환된 글 전체","summary":"주요 변환 포인트 2~3문장","detail":"카피킬러 우회를 위해 적용한 기법 설명"}`;
}

// 텍스트 분석
app.post('/analyze', async (req, res) => {
  try {
    const { mode, text } = req.body;
    if (!text || text.length < 5) return res.json({ error: '텍스트가 너무 짧습니다.' });
    const prompt = mode === 'detect' ? getDetectPrompt(text) : getHumanizePrompt(text);
    const result = await callClaude(prompt);
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
    if (!text || text.length < 20) return res.json({ error: 'PDF에서 텍스트를 추출할 수 없습니다.' });
    const prompt = mode === 'detect' ? getDetectPrompt(text) : getHumanizePrompt(text);
    const result = await callClaude(prompt);
    res.json({ ok: true, result, extractedText: text.substring(0, 500) });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('서버 시작!'));
