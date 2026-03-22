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
  return `당신은 카피킬러 AI 탐지를 전문적으로 우회하는 전문가입니다.

[원문]
${text}

## 목표
카피킬러 AI 탐지 0~20% 달성

## 카피킬러가 AI로 판단하는 핵심 패턴 (반드시 제거)
1. 논리가 너무 완벽한 흐름 (문제→원인→해결→결론)
2. 문장 완결성이 너무 높음
3. 접속어가 흐름을 자연스럽게 이어줌
4. 모든 문장이 주어+서술어 구조로 완결됨
5. 어휘 선택이 너무 적절하고 다양함

## 인간 글의 특징 (반드시 반영)
1. **불완전한 문장**: 주어 생략, 서술어 생략 가끔 허용
2. **논리 비약**: 앞 문장과 갑자기 다른 내용으로 전환되는 경우도 있음
3. **띄어쓰기/맞춤법 소소한 실수** 1~2개 의도적으로 삽입 (심각한 오류 아닌 것)
4. **같은 단어 반복**: 인간은 가끔 같은 단어를 반복 사용함
5. **감탄사/추임새**: "사실", "솔직히", "뭐랄까", "어떻게 보면" 같은 표현 1~2개
6. **문장 길이 극단적 불균형**: 아주 짧은 문장(5자 이하)과 아주 긴 문장(70자 이상) 혼재

## 구체적 변환 방법
- 원문 문장을 절대 그대로 쓰지 말 것 (모든 문장 재작성)
- 원문 단어의 70% 이상을 다른 표현으로 교체
- 문장 순서를 원문과 다르게 배치
- 2~3문장을 하나로 합치거나, 1문장을 여러 개로 나누기

## 문체 유지 (유일한 절대 규칙)
- ~이다/~했다 체 → 그대로
- ~습니다/~입니다 체 → 그대로
- 절대 문체 변환 없음, 구어체 삽입 없음

원문 핵심 내용과 의미는 유지하되, 카피킬러가 AI로 못 잡도록 최대한 인간적 불완전함을 담아 완전히 새로 쓸 것.

JSON으로만 응답:
{"outputText":"변환된 글 전체","summary":"변환 요약","detail":"적용 기법"}`;
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
