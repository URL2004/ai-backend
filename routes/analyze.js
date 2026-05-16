// [분석 API] 텍스트/PDF AI 탐지 및 휴머나이즈 처리
// ★ 탐지(detect)·휴머나이즈·웹 검색 모두 Anthropic Claude.
// ★ Anthropic prompt caching: detect/humanize 시스템 프롬프트에 cache_control: ephemeral (5분 TTL, 1024+ 토큰).

const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { getDetectSystem, getHumanizeSystem } = require('../prompts');
const { admin, db } = require('../config');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const WEB_SEARCH_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';

// 토큰 검증 + 잔량 사전 확인. Firestore 읽기만. 차감 없음.
async function precheckCredits(idToken, needed) {
  if (!idToken) throw Object.assign(new Error('AUTH_REQUIRED'), { status: 401 });
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { throw Object.assign(new Error('AUTH_INVALID'), { status: 401 }); }
  const uid = decoded.uid;
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
  const d = snap.data();
  const plan = d.plan || 'free';
  if (plan === 'unlimited') return { uid, plan };
  const credits = d.credits || 0;
  if (credits < needed) throw Object.assign(new Error('INSUFFICIENT_CREDITS'), { status: 402 });
  return { uid, plan };
}

// 결과 정상 후 호출. 원자적 차감 + creditHistory 기록.
// 트랜잭션 안에서 다시 잔량을 검증해 동시 호출 레이스에서도 안전.
async function commitCreditDeduct(uid, needed, opType) {
  const userRef = db.collection('users').doc(uid);
  await db.runTransaction(async (t) => {
    const snap = await t.get(userRef);
    if (!snap.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
    const d = snap.data();
    if ((d.plan || 'free') === 'unlimited') return;
    const credits = d.credits || 0;
    if (credits < needed) throw Object.assign(new Error('INSUFFICIENT_CREDITS'), { status: 402 });
    const newCredits = credits - needed;
    t.update(userRef, { credits: newCredits });
    const hist = userRef.collection('creditHistory').doc();
    t.set(hist, {
      type: opType, used: needed, amount: 0, remaining: newCredits,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
}

// 정기결제(Pro 탭) 쿠폰 검증 + 1회 차감. 결제는 텍스트 길이 1회당 쿠폰 1개.
const SUB_CHAR_LIMITS = { '1000': 1000, '5000': 5000, '10000': 10000, 'unlimited': -1 };

// 쿠폰: 토큰 검증 + 구독 유효성 + 잔량/한도 확인. Firestore 읽기만.
async function precheckCoupon(idToken, textLength) {
  if (!idToken) throw Object.assign(new Error('AUTH_REQUIRED'), { status: 401 });
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { throw Object.assign(new Error('AUTH_INVALID'), { status: 401 }); }
  const uid = decoded.uid;
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
  const d = snap.data();
  const sub = d.subscription;
  if (!sub) throw Object.assign(new Error('NO_SUBSCRIPTION'), { status: 403 });
  const nextMs = sub.nextBillingAt?.toMillis ? sub.nextBillingAt.toMillis() : 0;
  const valid = sub.status === 'active' || (sub.status === 'cancelled' && nextMs > Date.now());
  if (!valid) throw Object.assign(new Error('SUBSCRIPTION_INACTIVE'), { status: 403 });
  const tier = sub.tier;
  const charLimit = SUB_CHAR_LIMITS[tier];
  if (charLimit === undefined) throw Object.assign(new Error('INVALID_TIER'), { status: 500 });
  if (charLimit !== -1 && textLength > charLimit) {
    throw Object.assign(new Error('COUPON_LIMIT_EXCEEDED'), { status: 400, charLimit });
  }
  if (tier !== 'unlimited') {
    const remaining = d.coupon?.remaining ?? 0;
    if (remaining <= 0) throw Object.assign(new Error('NO_COUPON'), { status: 402 });
  }
  return { uid, billingMode: 'coupon', tier };
}

// 쿠폰: 결과 정상 후 호출. 원자적 차감 + couponHistory 기록.
async function commitCouponUsage(uid, tier, opType, textLength) {
  const userRef = db.collection('users').doc(uid);
  await db.runTransaction(async (t) => {
    const snap = await t.get(userRef);
    if (!snap.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
    const d = snap.data();
    const sub = d.subscription;
    if (!sub) throw Object.assign(new Error('NO_SUBSCRIPTION'), { status: 403 });
    if (tier === 'unlimited') {
      t.update(userRef, { 'coupon.used': admin.firestore.FieldValue.increment(1) });
      const hist = userRef.collection('couponHistory').doc();
      t.set(hist, {
        type: 'use', tier, amount: 0, remaining: -1,
        mode: opType, textLength,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return;
    }
    const remaining = d.coupon?.remaining ?? 0;
    if (remaining <= 0) throw Object.assign(new Error('NO_COUPON'), { status: 402 });
    const newRemaining = remaining - 1;
    t.update(userRef, {
      'coupon.remaining': newRemaining,
      'coupon.used': admin.firestore.FieldValue.increment(1)
    });
    const hist = userRef.collection('couponHistory').doc();
    t.set(hist, {
      type: 'use', tier, amount: -1, remaining: newRemaining,
      mode: opType, textLength,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
}

function authErrorMessage(code) {
  return ({
    AUTH_REQUIRED: '로그인이 필요합니다.',
    AUTH_INVALID: '로그인 정보가 만료됐어요. 다시 로그인해주세요.',
    USER_NOT_FOUND: '사용자 정보를 찾을 수 없습니다.',
    INSUFFICIENT_CREDITS: '크레딧이 부족합니다.',
    NO_SUBSCRIPTION: 'Pro 구독이 필요합니다.',
    SUBSCRIPTION_INACTIVE: '구독이 만료되었거나 활성 상태가 아닙니다.',
    NO_COUPON: '이번 사이클의 쿠폰을 모두 사용했습니다. 다음 결제일에 갱신됩니다.',
    COUPON_LIMIT_EXCEEDED: '현재 구독 티어의 글자 수 한도를 초과했습니다.',
    INVALID_TIER: '구독 정보가 올바르지 않습니다. 관리자에 문의해주세요.'
  })[code] || '인증/결제 확인에 실패했습니다.';
}

// ★ 구조화 출력용 schema 정의 (OpenAI strict json_schema 변환용 베이스)
// ★ mode별 스키마 분기: assignment만 의문문/접속사/P3/문단비율 필드 강제
// 함수명에 "Tool"이 남아 있는 건 기존 구조 유지용 — 실제로는 OpenAI strict json_schema로 변환됨
function buildHumanizeTool(mode, lang = 'ko') {
  // ★ tool schema 슬림화 (2026-05): 모델 자기보고 측정 필드 13개 + plan 제거.
  //   이전엔 모델이 카운트 못 하는 측정 필드를 채우게 한 뒤 verifyCheckFields가 다 덮어썼다 (이중 토큰 낭비).
  //   plan 필드(reasoning before answer)는 GSM8k 추론 task에 효과 검증된 거지 styling task엔 룰 의식 흔적만 박힘.
  //   서버 verifyCheckFields가 모든 측정을 직접 한다. 모델은 outputText 생성에만 집중.
  const isEn = lang === 'en';
  return {
    name: 'return_humanized_result',
    description: 'Return the rewritten text. Server measures all signature fields after; you do not need to count anything.',
    input_schema: {
      type: 'object',
      properties: {
        outputText: {
          type: 'string',
          description: isEn
            ? 'The full rewritten text. Apply the system prompt rules silently — do not output rule analysis.'
            : '변환된 글 전체. 시스템 프롬프트 룰을 따라 작성. 룰 분석·계획·검증 메타텍스트 출력 금지.'
        },
        summary: {
          type: 'string',
          description: isEn
            ? 'A 2-sentence summary of the transformation, written in English.'
            : '변환 요약 2문장. 존댓말(~입니다/~합니다체)로 작성.'
        },
        detail: {
          type: 'string',
          description: isEn
            ? 'Detailed description of the techniques applied, written in English.'
            : '적용한 기법 상세. 존댓말(~입니다/~합니다체)로 작성.'
        }
      },
      required: ['outputText', 'summary', 'detail']
    }
  };
}

function buildDetectTool(lang = 'ko') {
  const isEn = lang === 'en';
  return {
    name: 'return_detection_result',
    description: 'AI 생성 확률 판정 결과를 반환한다.',
    input_schema: {
      type: 'object',
      properties: {
        probability: { type: 'number', description: '0~100 사이 AI 생성 확률' },
        summary: {
          type: 'string',
          description: isEn
            ? 'Core judgment reasoning in 1–2 sentences, written in English.'
            : '핵심 판단 이유 1~2문장. 존댓말(~입니다/~합니다체)로 작성.'
        },
        detail: {
          type: 'string',
          description: isEn
            ? 'Detailed analysis of 100+ characters, written in English.'
            : '상세 분석 100자 이상. 존댓말(~입니다/~합니다체)로 작성.'
        }
      },
      required: ['probability', 'summary', 'detail']
    }
  };
}

// Anthropic Messages 응답에서 tool_use 블록 추출
// 강제 tool_choice 모드에서 모델은 항상 지정된 tool_use 블록을 반환한다.
function extractClaudeResult(data, toolName) {
  if (data?.type === 'error') {
    throw new Error(`Anthropic 응답 오류: ${data?.error?.message || 'unknown'}`);
  }
  const stopReason = data?.stop_reason;
  if (stopReason === 'refusal') {
    throw new Error('안전 필터에 의해 응답이 차단되었습니다.');
  }
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const refusal = blocks.find(b => b && b.type === 'refusal');
  if (refusal) {
    throw new Error(`안전 필터에 의해 응답이 거부되었습니다: ${refusal.message || ''}`);
  }
  const useBlock = blocks.find(b => b && b.type === 'tool_use' && b.name === toolName);
  if (!useBlock) {
    if (stopReason === 'max_tokens') {
      throw new Error('응답이 max_tokens 제한으로 잘렸습니다.');
    }
    throw new Error('모델이 구조화 응답을 반환하지 않았습니다.');
  }
  const parsed = useBlock.input && typeof useBlock.input === 'object' ? useBlock.input : {};
  // topNounCounts가 string으로 왔으면 객체로 정규화 (방어적 처리; 표준 JSON Schema에선 객체로 옴)
  if (parsed && typeof parsed.topNounCounts === 'string') {
    try { parsed.topNounCounts = JSON.parse(parsed.topNounCounts); }
    catch { parsed.topNounCounts = {}; }
  }
  if (parsed && parsed.topNounCounts && typeof parsed.topNounCounts !== 'object') {
    parsed.topNounCounts = {};
  }
  return parsed;
}

// Anthropic tools는 표준 JSON Schema(input_schema)를 그대로 받음 → 변환 불필요
function getDetectTool(lang = 'ko') {
  return buildDetectTool(lang);
}
function getHumanizeToolFor(mode, lang = 'ko') {
  return buildHumanizeTool(mode, lang);
}

// ★ 모델의 자기보고를 신뢰하지 않고 서버가 직접 실측. 실측 > 보고면 덮어쓰고 selfCheckPass를 재계산.
//   assignment 모드는 접속사 시작 비율/P3 마지막 문장/주제어 빈도/문단 비율까지 서버에서 추가 실측.
function verifyCheckFields(result, mode, inputParaCount, inputCharLen, inputText) {
  const text = result.outputText || '';
  const inText = typeof inputText === 'string' ? inputText : '';

  // 분량 90% 보장 실측: 출력 길이 / 원문 길이 (공백 제외 기준 통일)
  if (typeof inputCharLen === 'number' && inputCharLen > 0) {
    const outLen = text.replace(/\s+/g, '').length;
    const ratio = outLen / inputCharLen;
    result.lengthRatio = Number(ratio.toFixed(3));
    if (ratio < 0.9) {
      result.lengthShortfall = { input: inputCharLen, output: outLen, ratio: result.lengthRatio };
    } else {
      result.lengthShortfall = null;
    }
  }

  // 1) 3개 이상 나열: 콤마로 묶인 3요소 (한/영 모두)
  const commaListRe = /[가-힣A-Za-z0-9]+\s*,\s*[가-힣A-Za-z0-9]+\s*,\s*[가-힣A-Za-z0-9]+/g;
  // "정부, 기업, 개인" 같은 전형 + "A와 B, 그리고 C" 같은 변형
  const mixedListRe = /[가-힣]+(?:\s*(?:,|과|와))\s*[가-힣]+\s*(?:,\s*(?:그리고\s*)?|(?:과|와)\s*)[가-힣]+/g;
  const listMatches = new Set([
    ...(text.match(commaListRe) || []),
    ...(text.match(mixedListRe) || [])
  ]);
  const actualListCount = listMatches.size;

  // 2) 의문문: "?" 또는 전각 물음표로 끝나는 문장 수
  const actualQuestions = (text.match(/[?？]/g) || []).length;

  // 3) 15자 이하 단문 비율: "다./까?/요./!" 등 종결부 뒤로 분리해 공백 제외 길이 측정
  const sentences = text
    .split(/(?<=[.!?？。])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
  const charLen = (s) => s.replace(/\s+/g, '').length;
  const shortCount = sentences.filter(s => charLen(s) <= 15).length;
  const actualShortRatio = sentences.length > 0 ? shortCount / sentences.length : 0;

  const overrides = [];

  if (actualListCount > (result.listOfThreeCount || 0)) {
    overrides.push(`listOfThreeCount ${result.listOfThreeCount} → ${actualListCount}`);
    result.listOfThreeCount = actualListCount;
  }
  if (actualShortRatio < (result.shortSentenceRatio || 0)) {
    overrides.push(`shortSentenceRatio ${(result.shortSentenceRatio || 0).toFixed(2)} → ${actualShortRatio.toFixed(2)}`);
    result.shortSentenceRatio = actualShortRatio;
  }

  // ===== assignment 전용 확장 실측 =====
  if (mode === 'assignment') {
    // 의문문 실측: 모델 보고값과 다르면 덮어쓰기 (0건 위반 감지 위해 항상 주입)
    if (actualQuestions !== (result.questionSentenceCount || 0)) {
      overrides.push(`questionSentenceCount ${result.questionSentenceCount} → ${actualQuestions}`);
      result.questionSentenceCount = actualQuestions;
    }

    // 단정 정의문 카운트 — LLM overconfidence 시그너처 (학술 근거: arxiv 2510.26995, MASH 2601.08564)
    // 사용자 카피킬러 87% 감지 실측 분석: "[고유명사]는 ~사례입니다 / ~증거입니다 / ~보여줍니다" 패턴이 디텍터에 직접 잡힘.
    // 룰 5(무생물 정의문 회피)를 모델이 안 지키므로 측정→refine으로 강제.
    const declarativeRe = /[가-힣A-Za-z0-9]{2,}(?:은|는)\s+[^.!?]{4,}(사례입니다|사례이다|증거입니다|증거이다|증명입니다|증명이다|예시입니다|예시이다|상징입니다|상징이다|표현입니다|표현이다|결과입니다|결과이다|보여줍니다|보여준다|드러냅니다|드러낸다|증명합니다|증명한다|입증합니다|입증한다)[.!?]/g;
    const declarativeMatches = text.match(declarativeRe) || [];
    const actualDeclarativeDefinition = declarativeMatches.length;
    if (actualDeclarativeDefinition !== (result.declarativeDefinitionCount || 0)) {
      overrides.push(`declarativeDefinitionCount ${result.declarativeDefinitionCount} → ${actualDeclarativeDefinition}`);
      result.declarativeDefinitionCount = actualDeclarativeDefinition;
    }

    // 룰 1 마지막 문장 재보증/평가 패턴 실측 (교훈형 일반화 마무리 포함)
    const lastSentence = sentences[sentences.length - 1] || '';
    const reassureRe = new RegExp([
      '필요가 있다',
      '설득력 (있어 보이기도|있기도|있어 보이|있)',
      '얘기다',
      '정리하자면',
      '결론적으로',
      '더 중요해 보인다',
      '달려\\s?있다',
      '지속가능한지는',
      '재고할 필요',
      '(뭐|무엇|왜|어떻게|어떤지)(를|가|인지|인지를)?\\s*(조금씩|점점|서서히|비로소)?\\s*(알게|깨닫게|배우게|이해하게)\\s*(됩니다|된다|되었다|됐다)',
      '알게 됩니다[.!]?$',
      '깨닫게 됩니다[.!]?$',
      '배우게 됩니다[.!]?$',
      '된 것 같습니다[.!]?$',
      '는 것이었습니다[.!]?$'
    ].join('|'));
    const actualLastReassure = reassureRe.test(lastSentence);
    if (actualLastReassure && result.lastSentenceIsReassurance !== true) {
      overrides.push(`lastSentenceIsReassurance ${result.lastSentenceIsReassurance} → true`);
      result.lastSentenceIsReassurance = true;
    }

    // 주제어 실측: 2~4글자 한글 명사 추출 (조사 스트립 근사), 빈도 top 3 산출
    // 모델 보고에서 누락된 주제어가 실측에서 4회 이상이면 덮어쓰기
    const tokens = (text.match(/[가-힣]{2,4}/g) || [])
      .map(t => t.replace(/(은|는|이|가|을|를|에|의|와|과|도|만|로|으로|에서|에게|부터|까지)$/, ''))
      .filter(t => t.length >= 2);
    const freq = {};
    for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
    const topEntries = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const reportedCounts = result.topNounCounts || {};
    const reportedMax = Math.max(0, ...Object.values(reportedCounts));
    const actualMax = topEntries.length ? topEntries[0][1] : 0;
    if (actualMax >= 4 && actualMax > reportedMax) {
      const newCounts = Object.fromEntries(topEntries);
      overrides.push(`topNounCounts 최대 ${reportedMax} → ${actualMax} (${topEntries[0][0]})`);
      result.topNounCounts = newCounts;
    }

    // 문단 분리: 후속 룰(룰 2 similarLengthRun 등)에서 재사용
    const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

    // 문단 수 일치 실측: 입력 문단 수 vs 출력 문단 수 (작업 지침 — 원문 문단 수 보존)
    if (typeof inputParaCount === 'number' && inputParaCount > 1) {
      const outputParas = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
      if (outputParas.length !== inputParaCount) {
        overrides.push(`paragraphCount 입력 ${inputParaCount}개 → 출력 ${outputParas.length}개 불일치`);
        result.paragraphCountMismatch = { input: inputParaCount, output: outputParas.length };
      } else {
        result.paragraphCountMismatch = null;
      }
    }

    // ===== P1: 쉼표 복문 비율 + 쉼표 없는 3문장 연속 구간 =====
    const clauseEndingRe = /(?:다|니다|며|고|어서|아서|면서|는데|지만|었고|이며|되어|하여|하며)\s*,/;
    const commaClauseCount = sentences.filter(s => /,/.test(s) && clauseEndingRe.test(s)).length;
    const actualCommaClauseRatio = sentences.length > 0 ? commaClauseCount / sentences.length : 0;
    if (actualCommaClauseRatio > (result.commaClauseRatio || 0)) {
      overrides.push(`commaClauseRatio ${(result.commaClauseRatio || 0).toFixed(2)} → ${actualCommaClauseRatio.toFixed(2)}`);
      result.commaClauseRatio = actualCommaClauseRatio;
    }
    let noCommaRun = 0, shortRunCount = 0;
    for (const s of sentences) {
      if (!/,/.test(s) && /[다까요][.!?？。]?$/.test(s.trim())) {
        noCommaRun++;
        if (noCommaRun === 3) shortRunCount++;
      } else {
        noCommaRun = 0;
      }
    }
    if (shortRunCount > (result.shortRunWithoutComma || 0)) {
      overrides.push(`shortRunWithoutComma ${result.shortRunWithoutComma} → ${shortRunCount}`);
      result.shortRunWithoutComma = shortRunCount;
    }

    // ===== P2: 초단문(8자 이하) + 장문(40자+)-단문(10자-) 인접 =====
    const tinyCount = sentences.filter(s => charLen(s) <= 8).length;
    if (tinyCount < (result.tinySentenceCount ?? Infinity)) {
      overrides.push(`tinySentenceCount ${result.tinySentenceCount} → ${tinyCount}`);
      result.tinySentenceCount = tinyCount;
    }
    let adjacency = 0;
    for (let i = 0; i < sentences.length - 1; i++) {
      if (charLen(sentences[i]) >= 40 && charLen(sentences[i + 1]) <= 10) adjacency++;
    }
    if (adjacency < (result.longShortAdjacencyCount ?? Infinity)) {
      overrides.push(`longShortAdjacencyCount ${result.longShortAdjacencyCount} → ${adjacency}`);
      result.longShortAdjacencyCount = adjacency;
    }

    // ===== 룰 1: 동일 종결어미 연속 =====
    const endingGroup = (s) => {
      const t = s.trim();
      if (/같습니다[.!]?$/.test(t)) return 'GATDA';
      if (/겠습니다[.!]?$/.test(t)) return 'GETDA';
      if (/였습니다[.!]?$/.test(t)) return 'YEOT';
      if (/습니다[.!]?$/.test(t)) return 'SEUPNIDA';
      if (/ㅂ니다[.!]?$/.test(t)) return 'BNIDA';
      if (/까\??$/.test(t) || /\?$/.test(t)) return 'QUESTION';
      return 'OTHER';
    };
    let curGroup = null, runLen = 0, maxSameEnding = 0;
    for (const s of sentences) {
      const g = endingGroup(s);
      if (g === curGroup) runLen++;
      else { curGroup = g; runLen = 1; }
      if (g !== 'OTHER' && g !== 'QUESTION' && runLen > maxSameEnding) maxSameEnding = runLen;
    }
    if (maxSameEnding > (result.sameEndingRun || 0)) {
      overrides.push(`sameEndingRun ${result.sameEndingRun} → ${maxSameEnding}`);
      result.sameEndingRun = maxSameEnding;
    }

    // ===== 룰 2: 문단별 ±5자 이내 문장 길이 3연속 (15자 이상만 판정) =====
    let maxSimRun = 0;
    for (const p of paragraphs) {
      const ps = p.split(/(?<=[.!?？。])\s+/).map(s => s.trim()).filter(Boolean);
      const lens = ps.map(charLen);
      let simRun = 1;
      for (let i = 1; i < lens.length; i++) {
        if (lens[i] >= 15 && lens[i - 1] >= 15 && Math.abs(lens[i] - lens[i - 1]) <= 5) {
          simRun++;
          if (simRun > maxSimRun) maxSimRun = simRun;
        } else {
          simRun = 1;
        }
      }
    }
    if (maxSimRun > (result.similarLengthRun || 0)) {
      overrides.push(`similarLengthRun ${result.similarLengthRun} → ${maxSimRun}`);
      result.similarLengthRun = maxSimRun;
    }

    // ===== 룰 3: 명사 주어 연속 실측 (모델 자기보고 덮어쓰기) =====
    const nonNounStartRe = /^(사실|솔직히|결국|오히려|막상|어쩌면|돌이켜보면|어떤|이런|이렇게|그런|그렇게|하지만|그러나|그런데|그래서|한편|또한|아직|이미|아마|정말|진짜|특히|물론)/;
    const nounSubjectRe = /^[가-힣]+(은|는|이|가)\s/;
    let nsRun = 0, nsMax = 0;
    for (const s of sentences) {
      const t = s.trim();
      if (nounSubjectRe.test(t) && !nonNounStartRe.test(t)) {
        nsRun++;
        if (nsRun > nsMax) nsMax = nsRun;
      } else {
        nsRun = 0;
      }
    }
    if (nsMax > (result.consecutiveNounSubjectMax || 0)) {
      overrides.push(`consecutiveNounSubjectMax ${result.consecutiveNounSubjectMax} → ${nsMax}`);
      result.consecutiveNounSubjectMax = nsMax;
    }

    // ===== 룰 6: hedgeRatio 실측 (한국어 카피킬러는 hedge를 인간 시그너처로 학습 — critical 폐기됨, minor만) =====
    // 통과 글 분석으로 풀 확장: 받침 차이 흡수 위해 어간 부분만 매칭("고 생각", "지도 모")
    const hedgeRe = /(인 것 같|는 것 같|고 생각|던 것 같|았던 것 같|았을지도|지도 모|일 수도 있|인 듯|지 않을까)/;
    const hedgeCount = sentences.filter(s => hedgeRe.test(s)).length;
    const actualHedge = sentences.length > 0 ? hedgeCount / sentences.length : 0;
    if (Math.abs(actualHedge - (result.hedgeRatio || 0)) > 0.03) {
      overrides.push(`hedgeRatio ${(result.hedgeRatio || 0).toFixed(2)} → ${actualHedge.toFixed(2)}`);
      result.hedgeRatio = actualHedge;
    }

    // ===== hedge 균질화 검출: 동일 hedge 표현 글 전체 누적 =====
    // 사용자 카피킬러 100% 감지 실측 — hedge 풀세트 5종을 제시해도 LLM이 한 표현("것 같습니다")만 반복 sampling.
    // sameEndingRun(연속) 검증으론 비연속 누적이 빠짐 → 풀세트 다양화가 무력화돼 "기계적 균일성" 시그너처로 직격.
    const hedgeGroupRes = [
      { name: '것 같', re: /(?:인|는|던|았던|을) 것 같/g },
      { name: '고 생각', re: /고 생각(?:합니다|한다|해)/g },
      { name: '지도 모', re: /지도 모(?:릅니다|른다|르)/g },
      { name: '수도 있', re: /(?:일|할|될|을) 수(?:도 있| 있)/g },
      { name: '지 않을까', re: /지 않을까/g },
      // "~기도 합니다" 그룹 — 사용자 실측: "것 같"을 줄였더니 LLM이 이쪽으로 옮겨 재균질화.
      // 앞에 한글 1자+ 필수로 두어 단독 "기도(prayer)"는 제외 ("흔들리기도 합니다" 같은 보조사 결합만 잡힘).
      { name: '기도 합', re: /[가-힣]+기도\s+(?:합니다|했습니다|한다|하고|하며|하기도|함)/g }
    ];
    let topHedgeName = null, topHedgeCount = 0;
    for (const g of hedgeGroupRes) {
      const cnt = (text.match(g.re) || []).length;
      if (cnt > topHedgeCount) { topHedgeCount = cnt; topHedgeName = g.name; }
    }
    if (topHedgeCount > (result.dominantHedgeCount || 0)) {
      overrides.push(`dominantHedgeCount ${result.dominantHedgeCount || 0} → ${topHedgeCount} ("${topHedgeName}")`);
      result.dominantHedgeCount = topHedgeCount;
      result.dominantHedgeName = topHedgeName;
    }

    // ===== S2 (무하유 공식): 단락 단위 1인칭 anchor =====
    // 카피킬러가 4~5문장 단락을 이진분류 단위로 사용. 단락 내 1인칭이 0개면 그 단락 통째 빨강.
    // 글 전체 카운트는 부족 — 단락별로 최소 1건 강제. (출처: manual.muhayu.com/gpt-killer-labs)
    const firstPersonRe = /(저는|제가|저도|저의|저 자신|저로서는|개인적으로|제 생각|제 경험|저에게는|저한테는)/g;
    const firstPersonMatches = text.match(firstPersonRe) || [];
    result.firstPersonCount = firstPersonMatches.length;
    // 단락 단위 측정
    const paragraphsForFP = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    let paragraphsWithoutFP = 0;
    let minFPPerParagraph = Infinity;
    for (const p of paragraphsForFP) {
      const cnt = (p.match(firstPersonRe) || []).length;
      if (cnt === 0) paragraphsWithoutFP++;
      if (cnt < minFPPerParagraph) minFPPerParagraph = cnt;
    }
    result.paragraphsWithoutFirstPerson = paragraphsWithoutFP;
    result.minFirstPersonPerParagraph = minFPPerParagraph === Infinity ? 0 : minFPPerParagraph;

    // ===== S5 (무하유 공식): 단락 단위 주제어 반복 =====
    // S5 = "같은 키워드·내용을 글 전반에서 반복 확대". 단락 안에서 같은 명사가 3회+면 단락 시그너처.
    const noun3PlusRe = /[가-힣]{2,4}/g;
    let maxNounPerPara = 0;
    let worstNounInPara = null;
    for (const p of paragraphsForFP) {
      const tokens = (p.match(noun3PlusRe) || [])
        .map(t => t.replace(/(은|는|이|가|을|를|에|의|와|과|도|만|로|으로|에서|에게|부터|까지)$/, ''))
        .filter(t => t.length >= 2);
      const freq = {};
      for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
      for (const [w, c] of Object.entries(freq)) {
        if (c > maxNounPerPara) { maxNounPerPara = c; worstNounInPara = w; }
      }
    }
    result.maxNounRepetitionPerParagraph = maxNounPerPara;
    result.worstRepeatedNounInParagraph = worstNounInPara;

    // ===== S4 (무하유 공식): 단정문 비율 =====
    // S4 = "중립성 편향, 단정적/확신 표현 부족". hedge로만 일관하면 회피 시그너처.
    // 인간은 hedge와 단정을 섞어 씀. 단정문 30%+ 강제.
    // 단정문 = ~합니다/~입니다/~한다/~봅니다 등 종결 + hedge 패턴 없음 + 의문문 아님.
    const hedgeForAssertive = /(인 것 같|는 것 같|고 생각|던 것 같|았던 것 같|았을지도|지도 모|일 수도 있|인 듯|지 않을까|기도 합)/;
    let assertiveCount = 0;
    for (const s of sentences) {
      const t = s.trim();
      if (/[?？]$/.test(t)) continue;            // 의문문 제외
      if (hedgeForAssertive.test(t)) continue;   // hedge 문장 제외
      if (/[다까요]\.?$|입니다\.?$|합니다\.?$|봅니다\.?$|봅니다[.!]?$/.test(t)) {
        assertiveCount++;
      }
    }
    const assertiveRatio = sentences.length > 0 ? assertiveCount / sentences.length : 0;
    result.assertiveSentenceRatio = Number(assertiveRatio.toFixed(3));
    result.assertiveSentenceCount = assertiveCount;

    // ===== 수동·비인칭 동사 비율 검출 (카피킬러 피드백 3번 직격) =====
    // "수동태, 비인칭 구조 중심 → 글쓴이 관점 부재 = AI 패턴" 직격.
    // 1인칭이 들어가도 본문 동사 대부분이 수동·중간태면 비인칭 시그너처 박힘 (사용자 실측 — 1인칭 3회였는데도 100% 감지).
    const passiveRe = /(되었습니다|됐습니다|되어 있|되고 있|졌습니다|져 있|지고 있|혔습니다|혀 있|만들어졌|만들어집|만들어지는|받게 됩니다|받게 될|받게 된|여겨졌|여겨집|여겨지는|이루어졌|이루어집|이루어지는|확인됩|확인되었|드러납|드러난|보여집|보여졌|평가받게|평가받는|움직이고 있|이어지고 있|이어집니다|진행되고 있|정비되고 있|놓여 있|걸쳐 있|담겨 있|뒤집혔|뒤집힌|이끌리|밀려|치우치|기울)/;
    const passiveCount = sentences.filter(s => passiveRe.test(s)).length;
    const passiveRatio = sentences.length > 0 ? passiveCount / sentences.length : 0;
    result.passiveVoiceRatio = Number(passiveRatio.toFixed(3));
    result.passiveVoiceCount = passiveCount;

    // ===== 60자+ 장문 비율 검출 (카피킬러 피드백 1번 "압축·단절" 직격) =====
    // 사용자 실측: 60자+ 장문이 한 글 전체의 25%를 넘으면 "한 문단에 정보 압축, 문장 간 단절" 시그너처 박힘.
    // 콤마 누적 장문이 자주 동반됨 → commaClauseRatio와 묶어서 판단.
    const longCount = sentences.filter(s => charLen(s) >= 60).length;
    const longRatio = sentences.length > 0 ? longCount / sentences.length : 0;
    result.longSentenceRatio = Number(longRatio.toFixed(3));
    result.longSentenceCount = longCount;

    // ===== P0: 맞춤법/띄어쓰기 블랙리스트 =====
    const spellingRules = [
      { re: /것같(습니다|다|네요|아요|은)/, msg: '것같→것 같' },
      { re: /모든게/, msg: '모든게→모든 게' },
      { re: /(지식|사실|얘기|기술|감정|느낌|생각)이나중에/, msg: '~이나중에→~이 나중에' },
      { re: /(느낌|생각|기분|태도|감정|방식)부터다르/, msg: '~부터다르다→~부터 다르다' },
      { re: /(생겼|있었|없었|됐|했|갔|왔|봤|만났|나왔|들어왔|받았|줬|보냈|썼)을때/, msg: '~을때→~을 때' },
      { re: /(할|갈|올|볼|쓸|줄|받을|만날|나올|들어올|시작할|끝낼|마칠)때(마다|부터|까지|에|는|도)?/, msg: '~할때→~할 때' },
      { re: /(초등학교|중학교|고등학교|대학교|학원)\s까지/, msg: '학교 까지→학교까지' },
      { re: /(그때|이때|지금|나중|평소)\s까지/, msg: '~ 까지→~까지' },
      { re: /전날밤/, msg: '전날밤→전날 밤' },
      { re: /(어떻게|뭘|뭐|무엇을|왜|어디|어떤지|어찌|얼마나)\s*한건지/, msg: '한건지→한 건지' },
      { re: /해야할/, msg: '해야할→해야 할' },
      { re: /역효과\s였/, msg: '역효과 였습니다→역효과였습니다' },
      { re: /(부작용|효과|결과|차이|변화)\s였/, msg: '~ 였습니다→~였습니다' },
      // 의존명사 '게' 띄어쓰기 (사는게/오는게/먹는게/보는게/하는게/되는게/없는게/있는게/만드는게)
      { re: /(사는|오는|보는|먹는|하는|되는|없는|있는|만드는|쓰는|찾는|아는|모르는|가는|주는|받는|만나는|읽는|배우는|드는|남는|쌓는)게(\s|$|[.,!?])/, msg: '~는게→~는 게' },
      // 지시 관형사 '이/그/저' + 명사 붙여쓰기 (이인식/그느낌/저생각 등)
      // 주의: 것/곳/때/쪽/점은 '이것/그때' 같은 정식 합성어가 있어 제외
      { re: /(이|그|저)(인식|느낌|생각|사실|얘기|문제|결과|기능|방식|사람|기업|제품|브랜드|이미지|경험|효과|차이|변화|부분|상황|이유|순간|기준|관점|태도|행동|선택|결정|판단|평가|반응|모습|모양|특징|성격|성질|상태|조건|환경|분위기)([은는이가을를에의로]|\s|$|[.,!?])/, msg: '이/그/저+명사→띄어쓰기' },
      // 명사 + ' 입니다/인지/이다' (조사·서술격 잘못 띄움) — '인식 입니다', '관계 입니다'
      { re: /[가-힣]\s(입니다|인지|이다|이며|입니까|이었|이었습니다)(\s|$|[.,!?])/, msg: '명사 입니다→명사입니다' },
      // 합성 동사 '들여다보다/돌이켜보다/내려다보다/쳐다보다' 띄어쓰기 잘못
      { re: /(들여다|돌이켜|내려다|쳐다|올려다|훑어|살펴|돌아|들여다)\s(보|봤|본|보는|봅)/, msg: '합성동사→붙여 쓰기' },
      // '본 것' 의존명사 (이것이/그것이) + 동사 띄어쓰기 — 추가 안전망
      { re: /(된|한|할|할|쓴|본|들은|만든|받은|배운|찾은|준)걸(\s|$|[.,!?])/, msg: '~ㄴ걸→~ㄴ 걸' },
      // P0 추가 (사용자 글 실측 위반 — Pass C에서도 강제 치환됨)
      { re: /(추위|더위|비|바람|눈|햇볕|소음|적|위협|영향)\s+로부터/, msg: '~ 로부터→~로부터' },
      { re: /(구조물|건물|건축물|시설물|결과물|기능|기술|역할|수준|효과|영향|기대)이상의/, msg: '~이상의→~ 이상의' },
      { re: /(지속가능성|중요성|필요성|가치|효과|영향|결과|차이|모습|존재)\s+까지/, msg: '~ 까지→~까지' },
      { re: /(있|없|모르|아)는\s지(는|를|에|에서|보다|만|도)?([.,!?\s]|$)/, msg: '~는 지→~는지' },
      { re: /(완공|시작|건설|체결|발표|발견|도입|개최|설립)되었을때/, msg: '~되었을때→~되었을 때' },
      { re: /기도합니다/, msg: '기도합니다→기도 합니다' },
      { re: /한가지(로|만|에|가|를|도|의)/, msg: '한가지→한 가지' },
      { re: /(일|사실|영향|결과|효과|일상|문제|역할)뿐아니라/, msg: '~뿐아니라→~뿐 아니라' },
      { re: /(빠질|할|볼|쓸|올|갈|줄|얻을|받을|만날|보낼|읽을)수\s/, msg: '~ㄹ수→~ㄹ 수' },
      // ㄹ수+있/없 결합형 (사용자 글 실측 — "꺼낼수있는/통할수있을지/버틸수없지만")
      { re: /(빠질|할|볼|쓸|올|갈|잘|줄|얻을|받을|만날|보낼|읽을|꺼낼|버틸|통할|이길|살아남을|벗어날|치를|배울|이해할|판단할|해결할|찾을)수(있|없)/, msg: '~ㄹ수+있/없→~ㄹ 수 있/없' },
      // 의존명사 '데' (사용자 글 실측 — "갖추는데 있다")
      { re: /(지키|만들|살|쓰|배우|찾|보|걸|구하|이해하|받아들이|판단하|결정하|해결하|갖추|버티|통하|이기|적응하|대응하|성장하|살아남)는데\s+(있|의의|의미|도움|기여|초점|중점|목적|이유|핵심|목표|관건|보탬|어려움|걸림돌)/, msg: '~는데 (의존명사)→~는 데' }
    ];
    const spellIssues = spellingRules.filter(r => r.re.test(text)).map(r => r.msg);
    if (spellIssues.length > (result.spellingIssues?.length || 0)) {
      overrides.push(`spellingIssues ${(result.spellingIssues || []).length} → ${spellIssues.length}`);
      result.spellingIssues = spellIssues;
    }

    // ===== 절대 금지 1항 안전망: 사례 누적 / 사례 직후 해석 누락 실측 =====
    // evidence 문장 휴리스틱: 객관 사실/수치/인용 마커. 도메인 무관 일반화.
    const evidenceRe = new RegExp([
      '(?:19|20)\\d{2}',                                    // 연도
      '\\d+(?:\\.\\d+)?\\s*(?:%|％|퍼센트|배|건|명|개|곳|회|차|년|위|등)',  // 수치+단위
      '\\d+(?:,\\d{3})*\\s*(?:원|달러|엔|위안|유로|만|억|조)',          // 화폐/규모
      '(?:에 따르면|에 의하면|조사 결과|발표(?:했|에)|보고서|통계청|한국은행|기상청|p\\s*[<≤=]\\s*0\\.\\d+)'  // 인용·통계 마커
    ].join('|'));
    const evidenceFlags = sentences.map(s => evidenceRe.test(s));
    const actualEvidenceCount = evidenceFlags.filter(Boolean).length;
    if (actualEvidenceCount > (result.evidenceCount || 0)) {
      overrides.push(`evidenceCount ${result.evidenceCount} → ${actualEvidenceCount}`);
      result.evidenceCount = actualEvidenceCount;
    }

    // 사례 문장 직후 해석 누락: 다음 문장도 evidence이면 누락 카운트++
    // 마지막 문장이 evidence인 케이스는 lastSentenceIsReassurance/별도 룰에 맡기고 여기선 인접만 검출.
    let evidenceNoInterp = 0;
    for (let i = 0; i < evidenceFlags.length - 1; i++) {
      if (evidenceFlags[i] && evidenceFlags[i + 1]) evidenceNoInterp++;
    }
    if (evidenceNoInterp > (result.evidenceWithoutInterpretation || 0)) {
      overrides.push(`evidenceWithoutInterpretation ${result.evidenceWithoutInterpretation} → ${evidenceNoInterp}`);
      result.evidenceWithoutInterpretation = evidenceNoInterp;
    }

    // 단락별 사례 밀도: 한 단락당 최대 evidence 개수
    let evidencePerParaMax = 0;
    for (const p of paragraphs) {
      const ps = p.split(/(?<=[.!?？。])\s+/).map(s => s.trim()).filter(Boolean);
      const cnt = ps.filter(s => evidenceRe.test(s)).length;
      if (cnt > evidencePerParaMax) evidencePerParaMax = cnt;
    }
    if (evidencePerParaMax > (result.evidencePerParagraphMax || 0)) {
      overrides.push(`evidencePerParagraphMax ${result.evidencePerParagraphMax} → ${evidencePerParaMax}`);
      result.evidencePerParagraphMax = evidencePerParaMax;
    }

    // ===== C-11: 연결어미 뒤 쉼표 잔존 검출 (학술 SSOT — KatFish 인간 4.10% vs AI 19.83%) =====
    // enforceMechanicalRules의 deterministic 치환 사각지대 모니터링용.
    const endingCommaRe = /(고|며|지만|면서|아서|어서)\s*,/g;
    const endingCommaMatches = text.match(endingCommaRe) || [];
    result.endingCommaCount = endingCommaMatches.length;

    // ===== 결산 lexicon 4종 누적 (LREAD 인간 판독 60→90% 핵심 항목) =====
    // "결론적으로 / 따라서 / 이를 통해 / 그러므로" — 한 글 2회 초과 시 결산 정형성.
    const conclusionLex = ['결론적으로', '따라서', '이를 통해', '그러므로'];
    let pivotCount = 0;
    const pivotHits = [];
    for (const w of conclusionLex) {
      const cnt = (text.match(new RegExp(w, 'g')) || []).length;
      if (cnt > 0) pivotHits.push(`${w}×${cnt}`);
      pivotCount += cnt;
    }
    result.conclusionPivotCount = pivotCount;
    result.conclusionPivotHits = pivotHits;

    // ===== 절대 금지 핵심: 입력에 없는 신규 사실 주입 직접 차집합 =====
    // 사용자 카피킬러 100% 감지 실측 — LLM이 학습 데이터에서 연도·통계·기관명을 끌어와 박는 게 진범.
    // evidenceCount 누적만으론 "입력에 원래 있었던 사례"와 "신규 주입"을 구분 못 함 → 입력과 직접 비교.
    if (inText) {
      const extractYears = (s) => new Set(s.match(/(?:19|20)\d{2}/g) || []);
      const extractPercents = (s) => new Set(
        (s.match(/\d+(?:\.\d+)?\s*(?:%|％|퍼센트)/g) || []).map(p => p.replace(/\s+/g, ''))
      );
      // 한글 4자+ 단어 중 기관·기업 접미사로 끝나는 고유명사 (~상공회의소/~연구원/~공사/~협회/~재단/~위원회/~기구/~연구소/~본부/~센터)
      const orgRe = /[가-힣]{2,}(?:상공회의소|연구원|공사|협회|재단|위원회|기구|연구소|본부|센터|기관)/g;
      const inYears = extractYears(inText);
      const inPcts = extractPercents(inText);
      const outYears = extractYears(text);
      const outPcts = extractPercents(text);
      const inOrgs = new Set(inText.match(orgRe) || []);
      const outOrgs = new Set(text.match(orgRe) || []);
      const novelty = [];
      for (const y of outYears) if (!inYears.has(y)) novelty.push(y);
      for (const p of outPcts) if (!inPcts.has(p)) novelty.push(p);
      for (const o of outOrgs) if (!inOrgs.has(o)) novelty.push(o);
      if (novelty.length > 0) {
        overrides.push(`noveltyInjection ${novelty.join(', ')}`);
        result.noveltyInjectionCount = novelty.length;
        result.noveltyInjectionItems = novelty;
      } else {
        result.noveltyInjectionCount = 0;
        result.noveltyInjectionItems = [];
      }
    }
  }

  // 임계 기준으로 selfCheckPass 재계산. shouldRefine 임계와 정렬해 "달성 가능한 게이트"로 작동.
  let violations =
    (result.topNounCounts && Object.values(result.topNounCounts).some(n => n >= 4)) ||
    result.listOfThreeCount >= 1 ||
    result.consecutiveNounSubjectMax >= 4;  // 폐기한 옛 룰 3 잔재 정리, shouldRefine과 일치
    // shortSentenceRatio 위반 폐기 — 룰 2 갱신(평균 40~55자, 단문 *제한*)과 정면 충돌.
    // hedgeRatio 위반 폐기 (사용자 0% 통과 글 hedgeRatio 16.7% — 인간 분포가 5~20%).
    // 한국어 카피킬러는 hedge·관찰형 종결을 인간 시그너처로 학습.

  if (mode === 'assignment') {
    violations = violations
      || result.lastSentenceIsReassurance === true
      || (result.declarativeDefinitionCount || 0) >= 3
      || (result.evidenceCount || 0) >= 4
      || !!result.paragraphCountMismatch
      || (typeof result.commaClauseRatio === 'number' && result.commaClauseRatio > 0.15)
      || (typeof result.passiveVoiceRatio === 'number' && result.passiveVoiceRatio > 0.35)
      || (typeof result.longSentenceRatio === 'number' && result.longSentenceRatio > 0.30)
      // shortRunWithoutComma·tinySentenceCount·longShortAdjacencyCount 위반 폐기.
      // 룰 2(평균 40~55자, 단문 20~30자) + 룰 3(콤마 절제)과 충돌.
      // 단문 강제는 룰 2 단문 *제한* 방향과 정면 반대.
      || (result.sameEndingRun || 0) >= 4    // 프롬프트 룰 1 "4문장 연속 금지"와 일치
      || (result.similarLengthRun || 0) >= 3
      || (Array.isArray(result.spellingIssues) && result.spellingIssues.length > 0)
      || !!result.lengthShortfall
      || (result.evidenceWithoutInterpretation || 0) >= 1
      || (result.evidencePerParagraphMax || 0) >= 3
      || (result.noveltyInjectionCount || 0) >= 1
      || (result.dominantHedgeCount || 0) >= 4;
  }

  const recomputedPass = !violations;

  if (overrides.length > 0) {
    console.log(`🔎 서버 재검증 덮어쓰기: ${overrides.join(' | ')}`);
  }
  if (result.selfCheckPass !== recomputedPass) {
    console.log(`🔎 selfCheckPass 재계산: ${result.selfCheckPass} → ${recomputedPass}`);
    result.selfCheckPass = recomputedPass;
  }

  return result;
}

// 2-pass refine 게이트: critical 위반 1건이거나 minor 위반이 5건 이상일 때만 재호출.
// minor refine이 자주 발동하면 모델이 "룰 더 충족하는 방향"으로 다듬어 정형성이 짙어진다 → 임계 완화.
// ★ critical은 7개로 슬림화 — 게이트 다수가 critical이면 refine이 거의 매번 발동돼서
//   모델이 같은 글을 반복 다듬다 정형성 누적. 진짜 직격(P0/P1 안전망/분량/구조)만 critical.
function shouldRefine(result, mode) {
  const critical =
    (result.topNounCounts && Object.values(result.topNounCounts).some(n => n >= 4))    // 어휘 반복
    || (result.listOfThreeCount || 0) >= 1                                              // 콤마 3+ 나열
    || (Array.isArray(result.spellingIssues) && result.spellingIssues.length > 0)        // P0 맞춤법
    || !!result.lengthShortfall                                                          // 분량 90% 미달
    || (mode === 'assignment' && !!result.paragraphCountMismatch)                        // 문단 수 불일치
    || (mode === 'assignment' && (result.evidenceWithoutInterpretation || 0) >= 1)       // 사례 직후 해석 누락
    || (mode === 'assignment' && typeof result.commaClauseRatio === 'number' && result.commaClauseRatio > 0.25); // 콤마+절 누적 25%+
  if (critical) return { refine: true, reason: 'critical' };

  let minor = 0;
  // shortSentenceRatio < 0.15 minor 폐기 — 룰 2 갱신(단문 제한)과 충돌.
  if (typeof result.hedgeRatio === 'number' && (result.hedgeRatio < 0.07 || result.hedgeRatio > 0.22)) minor++;
  if ((result.consecutiveNounSubjectMax || 0) >= 4) minor++;
  if (mode === 'assignment') {
    if (typeof result.commaClauseRatio === 'number' && result.commaClauseRatio > 0.20) minor++;
    if ((result.sameEndingRun || 0) >= 4) minor++;
    if ((result.similarLengthRun || 0) >= 4) minor++;
    if ((result.questionSentenceCount || 0) === 0) minor++;
    if ((result.dominantHedgeCount || 0) >= 3) minor++;        // 옛 critical ≥4 흡수
    if ((result.firstPersonCount || 0) < 2) minor++;
    if (typeof result.passiveVoiceRatio === 'number' && result.passiveVoiceRatio > 0.25) minor++;   // 옛 critical >0.35 흡수
    if (typeof result.longSentenceRatio === 'number' && result.longSentenceRatio > 0.20) minor++;   // 옛 critical >0.30 흡수
    // 강등된 항목 (critical → minor)
    if (result.lastSentenceIsReassurance === true) minor++;
    if ((result.declarativeDefinitionCount || 0) >= 3) minor++;
    if ((result.evidenceCount || 0) >= 4) minor++;
    if ((result.evidencePerParagraphMax || 0) >= 3) minor++;
    if ((result.noveltyInjectionCount || 0) >= 1) minor++;
    // C-11 잔존 (학술 SSOT 도입) — enforce 치환 후에도 남으면 사각지대
    if ((result.endingCommaCount || 0) >= 1) minor++;
    // 결산 lexicon 4종 누적 — 한 글 3회+ 시 정형성
    if ((result.conclusionPivotCount || 0) >= 3) minor++;
    // S2 (무하유 공식): 단락 1인칭 anchor 부재 — 4~5문장 단락 통째 빨강
    if ((result.paragraphsWithoutFirstPerson || 0) >= 1) minor++;
    // S5 (무하유 공식): 단락 내 같은 명사 3회+ 반복
    if ((result.maxNounRepetitionPerParagraph || 0) >= 3) minor++;
    // S4 (무하유 공식): 단정문 30% 미만 = 회피 시그너처
    if (typeof result.assertiveSentenceRatio === 'number' && result.assertiveSentenceRatio < 0.30) minor++;
  }
  return { refine: minor >= 5, reason: minor >= 5 ? `minor x${minor}` : 'pass' };
}

// 셀프체크 수치를 임계와 대조해 위반된 항목을 사람이 읽을 문장으로 반환
function collectFailedFields(r, mode) {
  const failed = [];
  if (r.topNounCounts && Object.values(r.topNounCounts).some(n => n >= 4)) {
    const over = Object.entries(r.topNounCounts).filter(([, n]) => n >= 4).map(([k, n]) => `"${k}" ${n}회`).join(', ');
    failed.push(`주제어 4회 이상 반복(룰 5 어휘 다양화): ${over} — 지시어/유의어로 교체`);
  }
  if (r.listOfThreeCount >= 1) {
    failed.push(`3개 이상 나열 ${r.listOfThreeCount}건(룰 3 콤마 절 누적 금지, AI 시그너처) — 별도 문장으로 분리하거나 "A부터 C까지" 같은 구간 표현으로`);
  }
  if (r.lengthShortfall) {
    const pct = (r.lengthShortfall.ratio * 100).toFixed(0);
    failed.push(`분량 부족 ${pct}% (원문 ${r.lengthShortfall.input}자 → 출력 ${r.lengthShortfall.output}자, 최소 90% 보장) — 빠뜨린 원문 디테일·예시·근거를 복원해서 분량을 늘려라. 압축·요약 금지.`);
  }
  if (r.consecutiveNounSubjectMax >= 3) {
    failed.push(`명사 주어 ${r.consecutiveNounSubjectMax}연속 — 중간 문장을 부사/접속사/지시어로 시작`);
  }
  if (typeof r.hedgeRatio === 'number' && (r.hedgeRatio < 0.10 || r.hedgeRatio > 0.20)) {
    failed.push(`추정 어미 비율 ${(r.hedgeRatio * 100).toFixed(0)}%(룰 1 hedge 풀세트, 인간 분포 10~20%) — 자연스러운 분량으로 조정. hedge는 인간 시그너처라 너무 낮으면 LLM처럼 단정적, 너무 높으면 과교정.`);
  }
  if (mode === 'assignment') {
    if (r.lastSentenceIsReassurance === true) {
      failed.push(`마지막 문장이 재보증/평가(룰 1 hedge 마무리 위반) — '~할 필요가 있다/~에 달려 있다/~지속가능한지는' 대신 구체 사례·미해결 질문·관찰로 닫아라`);
    }
    if ((r.questionSentenceCount || 0) === 0) {
      failed.push(`의문문 0건(룰 1 변형 종결 권장 — 1~3건 자연 배치) — 정보를 진짜로 묻는 의문문 또는 hedge 의문문(~지 않을까요?, 정말 그럴까요?) 1건 정도 추가. 수사적 의문문은 사용 가능(인간 시그너처)`);
    }
    if (r.paragraphCountMismatch) {
      failed.push(`문단 수 불일치: 입력 ${r.paragraphCountMismatch.input}문단 → 출력 ${r.paragraphCountMismatch.output}문단. 원문의 문단 수를 그대로 유지하라. \\n\\n을 추가/삭제하지 말 것.`);
    }
    if (typeof r.commaClauseRatio === 'number' && r.commaClauseRatio > 0.15) {
      failed.push(`쉼표 복문 비율 ${(r.commaClauseRatio * 100).toFixed(0)}%(룰 3 콤마 절제, 목표 15% 이하 — KatFishNet 측정 한국어 LLM 시그너처 직격) — 쉼표로 이어붙인 긴 문장을 마침표로 끊어 독립 문장으로 재배치. 한 문장 콤마 1개 이하 권장. "A하고, B하며, C합니다" 식으로 절 3개 이어붙이면 카피킬러 "압축·단절" 시그너처 직격.`);
    }
    if (typeof r.passiveVoiceRatio === 'number' && r.passiveVoiceRatio > 0.25) {
      failed.push(`수동·비인칭 동사 ${(r.passiveVoiceRatio * 100).toFixed(0)}%(룰 7 수동태 회피, 목표 25% 이하) — 카피킬러 피드백 "수동태·비인칭 구조 중심 → 글쓴이 관점 부재" 직격. "여겨졌습니다 / 만들어집니다 / 뒤집혔습니다 / 정비되고 있고 / 이어지고 있습니다 / 평가받게 될" 같은 수동·중간태를 능동으로 전환. "기업이 ~을 한다 / 저는 ~을 본다 / 사람들은 ~을 고른다" 식의 명확한 주체+능동 동사로 절반 이상 교체.`);
    }
    if (typeof r.longSentenceRatio === 'number' && r.longSentenceRatio > 0.20) {
      failed.push(`60자+ 장문 비율 ${(r.longSentenceRatio * 100).toFixed(0)}%(룰 2 문장 길이, 목표 20% 이하) — 카피킬러 피드백 "지나친 요약·압축 서술 → 문장 간 단절" 직격. 60자+ 문장은 글 전체에서 25% 이내로. 콤마로 절을 이어 60자+로 늘이지 말고, 마침표로 30~50자 독립 문장 2~3개로 분할.`);
    }
    if ((r.sameEndingRun || 0) >= 3) {
      failed.push(`동일 종결어미 ${r.sameEndingRun}연속(룰 1 종결어미 다양화 — 4문장 연속 금지) — 3번째 문장을 변형 종결(~까요? / ~던 것 같습니다 / ~인지도 모릅니다 / ~기도 합니다)로 교체`);
    }
    if ((r.similarLengthRun || 0) >= 3) {
      failed.push(`문장 길이 ±5자 ${r.similarLengthRun}연속(룰 2 문장 길이) — 중간 문장을 대폭 줄이거나 늘려서 리듬 파괴. 평균 40~55자 권장 + 단문(20~30자) 1개 정도로 호흡 끊기, 중장문(50~75자) 자연스럽게 섞기.`);
    }
    if (Array.isArray(r.spellingIssues) && r.spellingIssues.length > 0) {
      failed.push(`맞춤법/띄어쓰기 오류(P0): ${r.spellingIssues.join(', ')} — 해당 표기 교정`);
    }
    if ((r.evidenceWithoutInterpretation || 0) >= 1) {
      failed.push(`사례 직후 해석 누락 ${r.evidenceWithoutInterpretation}건(절대 금지 1항 안전망) — 입력에 없는 연도·기업·통계가 새로 박혔다면 모두 제거. 입력에 있어 유지한 사례는 직후에 글쓴이 판단·의문·반전 1문장을 반드시 붙여라. 사례를 연달아 나열하지 마라.`);
    }
    if ((r.evidencePerParagraphMax || 0) >= 3) {
      failed.push(`한 단락에 사례 ${r.evidencePerParagraphMax}건 누적(절대 금지 1항 안전망, 최대 2건) — 입력에 없는 사례는 모두 제거. 입력 사례라도 한 단락에 1~2개까지만 두고, 직후에 글쓴이 해석을 붙여라.`);
    }
    if ((r.declarativeDefinitionCount || 0) >= 3) {
      failed.push(`단정 정의문 ${r.declarativeDefinitionCount}건(룰 4 고유명사+사실 단정 금지) — LLM overconfidence 시그너처 직격(학술 근거: arxiv 2510.26995 LLM 84.3% overconfident, MASH 2601.08564 ASR 92%). "[고유명사]는 ~사례입니다 / ~증거입니다 / ~보여줍니다 / ~상징입니다" 같은 confident declarative 패턴이 카피킬러에 직접 잡힘. 대신 "'~를 보면 / ~ 앞에 서면 / ~ 한 채에도" 같은 관찰·능동 시작으로 절반 이상 교체. 예: "엠파이어스테이트 빌딩은 그 시대 기술력의 사례입니다" → "엠파이어스테이트 빌딩을 보면 그 시대 기술력이 한눈에 들어옵니다".`);
    }
    if ((r.evidenceCount || 0) >= 4) {
      failed.push(`전체 사례 인용 ${r.evidenceCount}건(절대 금지 1항 critical, 권장 0~2건) — 사용자 카피킬러 87% 감지 실측: 사례·정량 사실이 한 글에 4건 이상 누적되면 LLM overconfidence 시그너처로 직접 잡힘. 입력 글에 없는 연도·기관명·통계는 모두 제거. 입력 사례는 추상 진술과 글쓴이 판단으로 갈아끼우고, 꼭 필요한 한두 개만 남겨라.`);
    }
    if ((r.noveltyInjectionCount || 0) >= 1) {
      const items = Array.isArray(r.noveltyInjectionItems) ? r.noveltyInjectionItems.join(', ') : '';
      failed.push(`입력 글에 없는 신규 사실 ${r.noveltyInjectionCount}건 주입 (절대 금지 직격): ${items} — 사용자 카피킬러 100% 감지 실측의 진범. 학습 데이터에서 끌어온 연도(YYYY)·통계(%)·기관명을 모두 제거하고, 해당 문장을 입력 글에 있는 추상 진술 + 글쓴이 관찰·판단으로 갈아끼워라. "유니레버/대한상공회의소" 같은 외래 고유명사 신규 주입도 금지.`);
    }
    if ((r.dominantHedgeCount || 0) >= 3) {
      failed.push(`동일 hedge 표현 "${r.dominantHedgeName || ''}" ${r.dominantHedgeCount}회 반복 — hedge 풀세트 다양화 효과 무력화로 "기계적 균일성" 시그너처 박힘 (카피킬러 피드백 직격). 같은 hedge는 글 전체에서 2회 이하로 제한하고, 나머지는 다른 형태(~던 것 같습니다 / ~지도 모릅니다 / ~기도 합니다 / ~지 않을까요?)로 분산. 단정 평서로 끝나도 무방.`);
    }
    if ((r.firstPersonCount || 0) < 2) {
      failed.push(`1인칭 anchor ${r.firstPersonCount || 0}건 (목표 2건+) — 카피킬러 피드백 "글쓴이 관점 부재 / 간접·비인칭 서술 반복" 직격. "제가 ~ 보면서 / 저는 ~ 했을 때 / 저로서는 ~" 같은 1인칭 시점을 글 중간에 2개 이상 자연스럽게 배치. 단, "저는" 4회+ 반복은 금지.`);
    }
    if ((r.endingCommaCount || 0) >= 1) {
      failed.push(`연결어미 뒤 쉼표 ${r.endingCommaCount}건 — 한국어 휴머나이저 학술 SSOT 기준 KatFish 분리도 4.84배(인간 4.10% vs AI 19.83%). "~고, / ~며, / ~지만, / ~면서, / ~아서, / ~어서," 패턴은 한국어 AI 글의 가장 강한 단일 시그너처. 해당 쉼표를 빼고 자연스럽게 이어 쓰거나 마침표로 끊어라.`);
    }
    if ((r.conclusionPivotCount || 0) >= 3) {
      const hits = Array.isArray(r.conclusionPivotHits) ? r.conclusionPivotHits.join(', ') : '';
      failed.push(`결산어 누적 ${r.conclusionPivotCount}건 [${hits}] — LREAD 인간 판독 60→90% 핵심 항목. "결론적으로 / 따라서 / 이를 통해 / 그러므로" 4종 합계 한 글 2회 이하로 제한. 결산 흐름은 "그래서 / 정리하면 / 그러니 / 그 결과" 같은 다양한 연결어로 분산하거나, 결산 자체를 빼고 관찰형 마무리("~는 모습입니다 / ~인 셈입니다")로 교체.`);
    }
    if ((r.paragraphsWithoutFirstPerson || 0) >= 1) {
      failed.push(`1인칭 anchor 없는 단락 ${r.paragraphsWithoutFirstPerson}개 (무하유 공식 S2 시그너처 직격) — 카피킬러는 4~5문장 단락 단위로 이진분류하므로 1인칭 anchor 없는 단락은 통째 빨강 처리됨. 모든 단락에 "제가 / 저는 / 저로서는 / 개인적으로" 같은 표현 최소 1건 자연 배치. 글 전체 카운트만 채우면 안 됨.`);
    }
    if ((r.maxNounRepetitionPerParagraph || 0) >= 3) {
      failed.push(`단락 내 명사 반복 — "${r.worstRepeatedNounInParagraph || ''}" ${r.maxNounRepetitionPerParagraph}회 (무하유 공식 S5 시그너처 직격: "같은 키워드·내용 글 전반 반복 확대 = AI 패턴"). 한 단락 안에서 같은 명사 2회 이하로 제한. 동의어 / 지시 대명사("이런 / 그런 / 해당") / 상위어로 분산.`);
    }
    if (typeof r.assertiveSentenceRatio === 'number' && r.assertiveSentenceRatio < 0.30) {
      failed.push(`단정문 비율 ${(r.assertiveSentenceRatio * 100).toFixed(0)}% (목표 30%+, 무하유 공식 S4 시그너처: "중립성 편향, 단정·확신 표현 부족 = AI 패턴"). hedge("것 같습니다 / 지도 모릅니다")만으로 일관하면 회피 시그너처. 3문장에 1번은 강한 단정 ("~합니다 / ~입니다 / ~한다고 봅니다") 필요. hedge와 단정 *섞어* 쓰기.`);
    }
  }
  return failed;
}

// --- 유틸리티 함수 ---

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

// ============================================================
// Pass C — mechanical 위반 결정론적 후처리
// 프롬프트 generative 룰의 잔여 surface 위반을 0건 보장.
// 의미 의존 룰(종결어미/문단 비율/hedge 등)은 손대지 않음 — 2-pass 영역.
// ============================================================

// Tier 1 surface 패턴 swap (LLM 호출 X, regex/lookup만)
// 출력 로그 보면서 자주 보이는 신종 GPT-ism을 늘려가는 자산
const MECHANICAL_LEXICON = [
  // 무생물 도입 (룰: 능동 종결 + 무생물 주어 회피 — backup)
  { from: /본\s*보고서에서는\s*/g, to: '' },
  { from: /본\s*보고서는/g, to: '이 글은' },
  { from: /본\s*글에서는\s*/g, to: '' },
  // GPT-ism 종결 정형구 (룰: 어휘 다양화 — backup)
  { from: /시사하는\s*바가\s*(크다|큽니다)/g, to: '의미가 큽니다' },
  { from: /결론적으로/g, to: '정리하면' },
  // GPT-ism 형용사 (어미 변형 안전한 형태만)
  { from: /유의미한/g, to: '의미 있는' },
  { from: /다각적/g, to: '여러 면의' },
  { from: /혁신적/g, to: '새로운' },
  { from: /뜻깊은/g, to: '의미 있는' },
  { from: /소중한/g, to: '중요한' },
  // P0 띄어쓰기 — LLM이 negative instruction 못 따르므로 deterministic 강제 (사용자 글 실측 위반)
  { from: /것같(다|습니다|아요|네요|은|던)/g, to: '것 같$1' },
  { from: /(추위|더위|비|바람|눈|햇볕|소음|적|위협|영향)\s+로부터/g, to: '$1로부터' },
  { from: /(구조물|건물|건축물|시설물|결과물|기능|기술|역할|수준|효과|영향|기대)이상의/g, to: '$1 이상의' },
  { from: /(지속가능성|중요성|필요성|가치|효과|영향|결과|차이|모습|존재)\s+까지/g, to: '$1까지' },
  { from: /(있|없|모르|아|어떠하)는\s지(는|를|에|에서|보다|만|도)?([.,!?\s]|$)/g, to: '$1는지$2$3' },
  { from: /기도합니다/g, to: '기도 합니다' },
  // P0: 의존명사 띄어쓰기 추가 안전망 (사용자 글 실측)
  { from: /(완공|시작|건설|체결|발표|발견|도입|개최|설립)되었을때/g, to: '$1되었을 때' },
  { from: /(지키|만들|살|쓰|배우|찾|보|걸|구하|이해하|받아들이|판단하|결정하|해결하|갖추|버티|통하|이기|적응하|대응하|성장하|살아남)는데\s+(있|의의|의미|도움|기여|초점|중점|목적|이유|핵심|목표|관건|보탬|어려움|걸림돌)/g, to: '$1는 데 $2' },
  { from: /(지키|만들|살|쓰|배우|찾|보|걸|구하|이해하|받아들이|판단하|결정하|해결하|갖추|버티|통하|이기|적응하|대응하|성장하|살아남)는데(\s|[.,!?])/g, to: '$1는 데$2' },
  { from: /한가지(로|만|에|가|를|도|의)/g, to: '한 가지$1' },
  { from: /(일|사실|영향|결과|효과|일상|문제|역할)뿐아니라/g, to: '$1뿐 아니라' },
  { from: /(빠질|할|볼|쓸|올|갈|잘|줄|얻을|받을|만날|보낼|읽을)수\s/g, to: '$1 수 ' },
  // ㄹ수+있/없 결합형 (사용자 글 실측 — "꺼낼수있는/통할수있을지/버틸수없지만")
  { from: /(빠질|할|볼|쓸|올|갈|잘|줄|얻을|받을|만날|보낼|읽을|꺼낼|버틸|통할|이길|살아남을|벗어날|치를|드릴|배울|이해할|판단할|해결할|찾을|쓸)수(있|없)/g, to: '$1 수 $2' }
];

function enforceMechanicalRules(text) {
  if (!text) return text;
  let out = text;

  // 1) 특수문자 (룰 1 — 프롬프트에서 제거됨, 여기서 100% 강제)
  out = out.replace(/·/g, ', ');                                     // 중점 → 콤마 (3+개면 Tier 2가 다시 처리)
  out = out.replace(/([가-힣])\s+[-—–]\s+([가-힣])/g, '$1 $2');      // 줄표 (공백 사이) → 공백
  // *, #, `, ~ 는 cleanText에서 이미 제거

  // 2) GPT-ism + 무생물 도입 swap (generative 룰의 backup)
  for (const { from, to } of MECHANICAL_LEXICON) {
    out = out.replace(from, to);
  }

  // 3) C-11: 연결어미 뒤 쉼표 제거 (한국어 휴머나이저 학술 SSOT — KatFish 4.84배 분리도)
  // 인간 4.10% vs AI 19.83% — 한국어에서 가장 강한 단일 시그너처. deterministic 치환으로 0%화.
  out = out.replace(/(고|며|지만|면서|아서|어서)\s*,/g, '$1');

  // 정리: 중복 공백, 마침표 앞 공백
  out = out.replace(/ {2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();
  return out;
}

// Tier 2: 3개 이상 콤마 나열을 그 문장만 LLM 외과수술로 해체.
// 위반 문장 1개당 micro-call (~150 토큰), 다른 문장은 손대지 않음.
// ★ \n\n 단락 경계 보존: sentences를 join하지 않고 원본 text 위에서 surgical replace.
async function fixListsOfThree(text, lang) {
  if (!text || !ANTHROPIC_API_KEY) return text;

  // verifyCheckFields와 동일 기준으로 문장 분리(매칭 검출용)
  const sentences = text.split(/(?<=[.!?？。])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  if (sentences.length === 0) return text;

  // 3+ 콤마 나열 패턴 (한/영/숫자 모두)
  const listRe = /[가-힣A-Za-z0-9]+(?:\s*,\s*[가-힣A-Za-z0-9]+){2,}/;

  const violating = sentences.filter(s => listRe.test(s));
  if (violating.length === 0) return text;

  // 원본 text 위에서 violating 문장만 in-place 교체 → \n\n·공백 그대로 유지
  let fixed = text;
  let cursor = 0;
  for (const original of violating) {
    try {
      const rewritten = await rewriteListSentence(original, lang);
      if (!rewritten || rewritten.length < original.length * 0.5) continue;
      const idx = fixed.indexOf(original, cursor);
      if (idx < 0) continue;  // 같은 문장 중복 시 이미 교체된 위치 스킵
      fixed = fixed.substring(0, idx) + rewritten + fixed.substring(idx + original.length);
      cursor = idx + rewritten.length;
    } catch (e) {
      // micro-call 실패 → 원문 그대로 (Pass C는 best-effort)
    }
  }
  return fixed;
}

async function rewriteListSentence(sentence, lang) {
  const prompt = lang === 'en'
    ? `Rewrite the following sentence to break the 3+ comma-separated list into either a "from A through C" range expression OR 2-3 short separate sentences.
- Do NOT change vocabulary, structure, ending style, or spelling outside the list portion.
- Preserve the original tone exactly.
- Output ONLY the rewritten sentence — no quotes, no commentary, no line breaks.

Sentence: ${sentence}`
    : `다음 문장에서 콤마로 묶인 3개 이상 나열만 해체하라.
- 나열을 "A부터 C까지" 같은 구간 표현 또는 짧은 별도 문장 2~3개로 분할
- 다른 어휘·구조·종결어미·맞춤법은 절대 변경 금지
- 원문 어조 그대로 유지
- 출력은 수정된 문장만. 따옴표·해설·줄바꿈 금지

문장: ${sentence}`;

  // Claude 텍스트 생성 (tool 없이) — 외과수술용 micro-call. 실패는 best-effort 폴백.
  let response;
  try {
    response = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }]
      })
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const data = await response.json();
  if (data?.stop_reason === 'refusal') return null;
  const blocks = Array.isArray(data?.content) ? data.content : [];
  let out = '';
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string') out += b.text;
  }
  out = out.trim();
  return out || null;
}

// 휴머나이저 출력에 cleanText + Tier 1 + Tier 2를 일괄 적용.
// 1차 출력과 2-pass 출력 각각에 호출 → mechanical 위반 잔여 0건 보장.
async function applyPassC(result, lang) {
  if (!result?.outputText) return;
  let t = cleanText(result.outputText);
  t = enforceMechanicalRules(t);
  t = await fixListsOfThree(t, lang);
  result.outputText = t;
}

// ─── Anthropic Messages API 호출 ─────────────────────────────
// 시스템 프롬프트는 cache_control: ephemeral로 5분 TTL 자동 캐싱 (1024+ 토큰 필요).
// 구조화 출력은 tool + tool_choice 강제 호출로 처리.
async function callClaude({ userText, systemText, tool, temperature, maxOutputTokens }) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const body = {
    model: MODEL,
    max_tokens: typeof maxOutputTokens === 'number' ? maxOutputTokens : 8192,
    messages: [{ role: 'user', content: userText }]
  };
  if (typeof temperature === 'number') body.temperature = temperature;

  if (systemText) {
    body.system = [{
      type: 'text',
      text: systemText,
      cache_control: { type: 'ephemeral' }
    }];
  }

  if (tool) {
    body.tools = [tool];
    body.tool_choice = { type: 'tool', name: tool.name };
  }

  const response = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();

  if (!response.ok) {
    const msg = data?.error?.message || response.statusText;
    throw new Error(`Anthropic API ${response.status}: ${msg}`);
  }

  if (data.usage) {
    const u = data.usage;
    const cacheCreate = u.cache_creation_input_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    console.log("-----------------------------------------");
    console.log(`📊 비용 리포트: 입력 ${u.input_tokens || 0} (캐시생성 ${cacheCreate}, 캐시읽기 ${cacheRead}) / 출력 ${u.output_tokens || 0}`);
    console.log("-----------------------------------------");
  }

  if (data.stop_reason === 'max_tokens') {
    console.log('⚠️ 응답이 max_tokens 제한으로 잘림');
  }

  return data;
}

// 웹 검색: Anthropic Messages API의 web_search 서버 도구 사용 (default ON).
// 실패/빈 응답이면 null 반환 → 호출 측은 기존 휴머나이즈 흐름과 동일하게 진행.
async function fetchWebSearchExamples(text, lang) {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const searchPrompt = lang === 'en'
      ? `Identify the topic of the following text and briefly provide 2-3 specific real-world examples or statistics related to it. Text: ${text.substring(0, 500)}`
      : `다음 글의 주제를 파악하고, 관련된 구체적인 실제 사례나 통계를 2~3개 간략히 제시해줘. 글: ${text.substring(0, 500)}`;

    const response = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: WEB_SEARCH_MODEL,
        max_tokens: 2048,
        messages: [{ role: 'user', content: searchPrompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
      })
    });
    if (!response.ok) return null;
    const data = await response.json();

    const blocks = Array.isArray(data?.content) ? data.content : [];
    let outputText = '';
    for (const b of blocks) {
      if (b && b.type === 'text' && typeof b.text === 'string') {
        outputText += b.text;
      }
    }
    if (outputText.length < 50) return null;
    return outputText.substring(0, 800);
  } catch (e) {
    return null;
  }
}

// --- 라우트 ---

router.post('/analyze', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] /analyze 요청 IP: ${ip}`);

  const { mode, text, idToken } = req.body;
  const lang = req.body.lang || 'ko';
  const billingMode = req.body.billingMode === 'coupon' ? 'coupon' : 'credit';
  // 프런트 분할 호출 시 전달되는 직전 청크 말미 (문체 참고용, ≤300자 안전 가드)
  const prevContext = typeof req.body.prevContext === 'string' && req.body.prevContext.trim()
    ? req.body.prevContext.trim().slice(-300)
    : '';
  if (!text || text.length < 5) return res.status(400).json({ error: '텍스트가 너무 짧습니다.' });
  // 글자 수 상한: 크레딧 모드 10,000자, 쿠폰 모드 50,000자(무제한 티어용 안전 캡)
  const HARD_MAX = billingMode === 'coupon' ? 50000 : 10000;
  if (text.length > HARD_MAX) {
    return res.status(400).json({ error: `텍스트가 너무 깁니다. (최대 ${HARD_MAX.toLocaleString()}자)` });
  }

  const needed = Math.ceil(text.length / 100);
  const opType = mode === 'detect' ? 'detect' : 'humanize';

  // 1) precheck — 토큰/잔량/구독 검증 (Firestore 읽기만, 차감 없음)
  let pre;
  try {
    pre = billingMode === 'coupon'
      ? await precheckCoupon(idToken, text.length)
      : await precheckCredits(idToken, needed);
  } catch (e) {
    return res.status(e.status || 500).json({
      error: authErrorMessage(e.message),
      ...(e.charLimit !== undefined ? { charLimit: e.charLimit } : {})
    });
  }

  // 2) LLM 호출 + 결과 검증 (실패 시 차감 없음)
  let result;
  let usage;
  let refineUsage = null;
  try {
    if (mode === 'detect') {
      const detectUserContent = prevContext
        ? `[앞 청크의 마지막 일부 — 문맥 참고용, 이 부분은 점수에 포함하지 말 것]\n${prevContext}\n\n[분석할 글]\n${text}`
        : `[분석할 글]\n${text}`;
      const detectSystem = getDetectSystem(lang);
      const detectTool = getDetectTool(lang);
      const data = await callClaude({
        userText: detectUserContent,
        systemText: detectSystem,
        tool: detectTool,
        maxOutputTokens: 4096
      });
      result = extractClaudeResult(data, detectTool.name);
      if (typeof result.probability !== 'number' || !result.summary || !result.detail) {
        throw new Error('detect_incomplete');
      }
      usage = data.usage;
    } else {
      // ★ 웹 검색: 기본 OFF로 변경 (사용자 실측 진단 결과).
      //    이전 기본 ON 동작이 카피킬러 96% 감지의 진범이었음:
      //    fetchWebSearchExamples가 외부 통계·연도·기관명을 user message에 박고 "녹여 활용" 지시 →
      //    모델이 단정 사실 + 통계 누적 → LLM overconfidence 시그너처 직격.
      //    웹 Claude는 web search 없이도 0% 통과 (사용자 실측 확정).
      //    프런트에서 useWebSearch=true 명시한 호출만 ON.
      const useWebSearch = req.body.useWebSearch === true;
      const examples = useWebSearch ? await fetchWebSearchExamples(text, lang) : null;

      // ★ 휴머나이저: Claude Sonnet tool_use(강제)로 호출. 시스템 프롬프트는 그대로.
      const selectedMode = req.body.humanizeMode || 'assignment';
      const humanizeSystem = getHumanizeSystem(selectedMode, lang);
      const humanizeTool = getHumanizeToolFor(selectedMode, lang);
      const prevContextBlock = prevContext
        ? `[앞 청크의 마지막 일부 — 문체 연속성 참고용, 다시 변환하지 말 것]\n${prevContext}\n\n`
        : '';
      const userContent = examples
        ? `${prevContextBlock}[재작성할 텍스트]\n${text}\n\n[참고할 실제 사례/통계 (자연스럽게 녹여 활용)]\n${examples}`
        : `${prevContextBlock}[재작성할 텍스트]\n${text}`;
      const inputParaCount = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean).length;
      const inputCharLen = text.replace(/\s+/g, '').length;

      const data = await callClaude({
        userText: userContent,
        systemText: humanizeSystem,
        tool: humanizeTool,
        temperature: 0.5,
        maxOutputTokens: 16384
      });
      result = extractClaudeResult(data, humanizeTool.name);
      // Pass C: cleanText + 결정론적 mechanical 후처리 (특수문자, GPT-ism, 3+ 나열).
      // verifyCheckFields가 후처리된 텍스트를 보게 해서 2-pass가 mechanical 위반으론 발동하지 않게 함.
      await applyPassC(result, lang);
      verifyCheckFields(result, selectedMode, inputParaCount, inputCharLen, text);

      // ★ 2-pass 폴백: critical 위반 1건 또는 minor 2건+일 때만 재호출 (비용 절약)
      const refineDecision = shouldRefine(result, selectedMode);
      if (refineDecision.refine) {
        const failed = collectFailedFields(result, selectedMode);
        console.log(`⚠️ 2-pass 발동 [${refineDecision.reason}]. 위반: ${failed.join(' | ')}`);
        const refineUser = `[원본 텍스트 — 정보 복원 시 참고용. 그대로 옮기지 말고 1차 출력 톤 유지]\n${text}\n\n[이전 출력]\n${result.outputText}\n\n[위반 항목]\n${failed.join('\n')}\n\n위반된 부분만 최소 수정하라. 다른 문장은 그대로 유지. 분량 부족이 위반 항목에 있으면 [원본 텍스트]에서 빠진 디테일·근거·예시를 복원해 채워라(원본 문장 그대로 복사 X — 1차 출력 톤으로 다시 써라). 새로운 흐름 꺾기 한정어·메타 사색·종결 어미 변형을 추가하지 마라(추가하면 정형성이 짙어져 디텍터에 더 잘 잡힌다). 수정 후 체크리스트 수치를 실제로 다시 세서 채워라.`;
        const refineData = await callClaude({
          userText: refineUser,
          systemText: humanizeSystem,
          tool: humanizeTool,
          temperature: 0.5,
          maxOutputTokens: 16384
        });
        result = extractClaudeResult(refineData, humanizeTool.name);
        await applyPassC(result, lang);
        verifyCheckFields(result, selectedMode, inputParaCount, inputCharLen, text);
        refineUsage = refineData.usage;
        if (result.selfCheckPass === false) {
          console.log(`⚠️ 2-pass 후에도 selfCheckPass=false. 결과 그대로 반환.`);
        }
      }

      if (!result.outputText) throw new Error('humanize_incomplete');
      usage = data.usage;
    }
  } catch (err) {
    console.error('/analyze LLM error:', err && err.message);
    return res.status(500).json({ error: '처리 중 오류가 발생했습니다. 크레딧은 차감되지 않았습니다.' });
  }

  // 3) 결과 정상 → 차감 (실패 시 결과 응답 안 함)
  try {
    if (billingMode === 'coupon') {
      await commitCouponUsage(pre.uid, pre.tier, opType, text.length);
    } else if (pre.plan !== 'unlimited') {
      await commitCreditDeduct(pre.uid, needed, opType);
    }
  } catch (e) {
    console.error('/analyze deduct fail:', e?.code, e?.message);
    return res.status(500).json({ error: '결제 처리 중 일시적인 오류가 발생했어요. 잠시 뒤 다시 시도해주세요.' });
  }

  // 4) 응답
  res.json({ ok: true, result, usage, refineUsage });
});

router.post('/analyze-pdf', upload.single('pdf'), async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] /analyze-pdf 요청 IP: ${ip}`);

  if (!req.file) return res.status(400).json({ error: 'PDF 파일이 없습니다.' });
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: 'PDF 파일만 업로드 가능합니다.' });
  }

  const mode = req.body.mode || 'detect';
  const lang = req.body.lang || 'ko';
  const idToken = req.body.idToken;
  const billingMode = req.body.billingMode === 'coupon' ? 'coupon' : 'credit';
  const opType = mode === 'detect' ? 'detect' : 'humanize';

  let pdfText;
  try {
    const pdfData = await pdfParse(req.file.buffer);
    pdfText = pdfData.text.trim();
  } catch (e) {
    return res.status(400).json({ error: 'PDF 파싱에 실패했습니다.' });
  }
  if (!pdfText || pdfText.length < 5) {
    return res.status(400).json({ error: 'PDF에서 텍스트를 추출할 수 없습니다.' });
  }

  const needed = Math.ceil(req.file.size / 10240);

  // 1) precheck — 토큰/잔량/구독 검증 (Firestore 읽기만, 차감 없음)
  let pre;
  try {
    pre = billingMode === 'coupon'
      ? await precheckCoupon(idToken, pdfText.length)
      : await precheckCredits(idToken, needed);
  } catch (e) {
    return res.status(e.status || 500).json({
      error: authErrorMessage(e.message),
      ...(e.charLimit !== undefined ? { charLimit: e.charLimit } : {})
    });
  }

  // 2) LLM 호출 + 결과 검증 (실패 시 차감 없음)
  let result;
  let usage;
  try {
    const text = pdfText;
    const humanizeModePdf = req.body.humanizeMode || 'assignment';
    if (mode === 'detect') {
      const detectSystem = getDetectSystem(lang);
      const detectTool = getDetectTool(lang);
      const data = await callClaude({
        userText: `[분석할 글]\n${text}`,
        systemText: detectSystem,
        tool: detectTool,
        maxOutputTokens: 4096
      });
      result = extractClaudeResult(data, detectTool.name);
      if (typeof result.probability !== 'number' || !result.summary || !result.detail) {
        throw new Error('detect_incomplete');
      }
      usage = data.usage;
    } else {
      const humanizeSystem = getHumanizeSystem(humanizeModePdf, lang);
      const humanizeTool = getHumanizeToolFor(humanizeModePdf, lang);
      const data = await callClaude({
        userText: `[재작성할 텍스트]\n${text}`,
        systemText: humanizeSystem,
        tool: humanizeTool,
        temperature: 0.5,
        maxOutputTokens: 16384
      });
      result = extractClaudeResult(data, humanizeTool.name);
      await applyPassC(result, lang);
      if (!result.outputText) throw new Error('humanize_incomplete');
      usage = data.usage;
    }
  } catch (err) {
    console.error('/analyze-pdf LLM error:', err && err.message);
    return res.status(500).json({ error: '처리 중 오류가 발생했습니다. 크레딧은 차감되지 않았습니다.' });
  }

  // 3) 결과 정상 → 차감
  try {
    if (billingMode === 'coupon') {
      await commitCouponUsage(pre.uid, pre.tier, opType, pdfText.length);
    } else if (pre.plan !== 'unlimited') {
      await commitCreditDeduct(pre.uid, needed, opType);
    }
  } catch (e) {
    console.error('/analyze-pdf deduct fail:', e?.code, e?.message);
    return res.status(500).json({ error: '결제 처리 중 일시적인 오류가 발생했어요. 잠시 뒤 다시 시도해주세요.' });
  }

  // 4) 응답
  res.json({
    ok: true,
    result,
    usage,
    extractedText: pdfText.substring(0, 500)
  });
});

router.verifyCheckFields = verifyCheckFields;
router.collectFailedFields = collectFailedFields;
module.exports = router;
