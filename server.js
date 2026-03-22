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
카피킬러에서 AI 판정 0~20% 달성. 단순 표현 교체가 아니라 글의 흐름과 구조 자체를 바꿔야 한다.

## 카피킬러 우회 핵심 전략

**1. 문장 구조 완전 해체**
- 원문 문장을 그대로 쓰지 말 것. 모든 문장을 새로 작성하되 의미만 유지
- 2문장을 1문장으로 합치거나, 1문장을 2~3문장으로 쪼개기
- 문장 순서를 원문과 다르게 배치

**2. 어휘 전면 교체**
- 원문에 쓰인 단어를 그대로 쓰지 말 것 (고유명사, 전문용어 제외)
- 유의어, 방언적 표현, 구어적 표현으로 교체
- 예: "대기 오염" → "공기 오염", "녹지 공간" → "녹색 지대"

**3. 인간적 불규칙성 삽입**
- 완벽한 논리 전개 대신 감정적 표현, 개인 의견, 약간의 비약 삽입
- 문장 끝에 가끔 "...싶다", "...보인다", "...느낌이다" 같은 주관적 표현
- 논리 흐름이 100% 완벽하지 않아도 됨

**4. 리듬 파괴**
- 짧은 문장(3~7자): 최소 3개 이상 삽입
- 매우 긴 문장(60자 이상): 1~2개 삽입
- 중간 길이만 있으면 안 됨

**5. 문체 유지 (이것만 지킬 것)**
- ~이다/~했다 체이면 그대로, ~습니다 체이면 그대로
- 절대 문체 변환 없음

원문 핵심 내용은 유지하되, 원문과 최대한 다른 표현으로 완전히 새로 쓴다는 느낌으로 작성할 것.

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
