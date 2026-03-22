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
  return `당신은 AI 탐지 시스템을 완벽하게 우회하는 세계 최고 전문가입니다.

[변환할 글]
${text}

## 핵심 목표
GPTZero, Turnitin, Copyleaks 등 모든 AI 탐지기에서 30% 이하로 변환

## 문체 감지 및 유지 (최우선)
- "~이다/~했다" 체 → 논문/레포트 문체 그대로 유지
- "~습니다/~입니다" 체 → 자소서/공문서 문체 유지
- 절대 문체 변환 금지 / "~요", "~거든요" 대화체 삽입 금지
- 자문자답 형식 절대 금지

## AI 냄새 제거
- "또한", "따라서", "이러한", "이를 통해", "뿐만 아니라" 전면 삭제
- "~할 수 있습니다", "~하는 것이 중요합니다" 교체
- 완벽한 기승전결 구조 해체
- 문장 길이 불규칙하게 조정

## 인간적 요소 삽입 (문체에 맞게)
- 논문/레포트: 주관적 시각, 의문 제기, 구체적 사례
- 자소서: 구체적 경험, 감정, 개인 동기 강조

원문 핵심 내용 반드시 유지

반드시 아래 JSON 형식으로만 응답 (마크다운, 설명 없이):
{"outputText":"변환된 글 전체","summary":"변환 요약 2~3문장","detail":"변환 포인트 설명"}`;
}

// 텍스트 분석
app.post('/analyze', async (req, res) => {
  try {
    const { mode, text } = req.body;
    if (!text || text.length < 20) return res.json({ error: '텍스트가 너무 짧습니다.' });
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
