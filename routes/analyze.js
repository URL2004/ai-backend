// [분석 API] 텍스트/PDF AI 탐지 및 휴머나이즈 처리 + Claude API 호출 유틸
// ★ 캐싱 최적화: 고정 프롬프트를 system에 넣어 cache_control 적용

const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { getDetectSystem, getHumanizeSystem } = require('../prompts');
const { admin, db } = require('../config');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

// idToken 검증 + 크레딧 원자적 예약(차감). 실패 시 status 코드 포함 에러 throw.
async function verifyAndReserveCredits(idToken, needed, opType) {
  if (!idToken) throw Object.assign(new Error('AUTH_REQUIRED'), { status: 401 });
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { throw Object.assign(new Error('AUTH_INVALID'), { status: 401 }); }
  const uid = decoded.uid;
  const userRef = db.collection('users').doc(uid);
  let reserved = 0;
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
    reserved = needed;
  });
  return { uid, reserved };
}

// LLM 실패 시 예약된 크레딧 환불.
async function refundCredits(uid, amount) {
  if (!amount) return;
  try {
    await db.collection('users').doc(uid).update({
      credits: admin.firestore.FieldValue.increment(amount)
    });
  } catch (e) { console.error('refund fail', e); }
}

// 정기결제(Pro 탭) 쿠폰 검증 + 1회 차감. 결제는 텍스트 길이 1회당 쿠폰 1개.
const SUB_CHAR_LIMITS = { '1000': 1000, '5000': 5000, '10000': 10000, 'unlimited': -1 };

async function verifyAndReserveCoupon(idToken, textLength, opType) {
  if (!idToken) throw Object.assign(new Error('AUTH_REQUIRED'), { status: 401 });
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { throw Object.assign(new Error('AUTH_INVALID'), { status: 401 }); }
  const uid = decoded.uid;
  const userRef = db.collection('users').doc(uid);

  let billingTier = null;
  await db.runTransaction(async (t) => {
    const snap = await t.get(userRef);
    if (!snap.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
    const d = snap.data();
    const sub = d.subscription;
    if (!sub) throw Object.assign(new Error('NO_SUBSCRIPTION'), { status: 403 });

    const nextMs = sub.nextBillingAt?.toMillis ? sub.nextBillingAt.toMillis() : 0;
    const valid = sub.status === 'active' || (sub.status === 'cancelled' && nextMs > Date.now());
    if (!valid) throw Object.assign(new Error('SUBSCRIPTION_INACTIVE'), { status: 403 });

    const tier = sub.tier;
    billingTier = tier;
    const charLimit = SUB_CHAR_LIMITS[tier];
    if (charLimit === undefined) throw Object.assign(new Error('INVALID_TIER'), { status: 500 });
    if (charLimit !== -1 && textLength > charLimit) {
      throw Object.assign(new Error('COUPON_LIMIT_EXCEEDED'), { status: 400, charLimit });
    }

    if (tier === 'unlimited') {
      // unlimited는 잔량은 차감하지 않지만 used 카운터는 증가시켜 환불 자격 판정에 활용
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

  return { uid, billingMode: 'coupon', tier: billingTier };
}

// LLM 실패 시 쿠폰 1개 복구. unlimited는 remaining은 안 건드리고 used만 복구.
async function refundCoupon(reservation) {
  if (!reservation || reservation.billingMode !== 'coupon') return;
  try {
    const patch = { 'coupon.used': admin.firestore.FieldValue.increment(-1) };
    if (reservation.tier !== 'unlimited') patch['coupon.remaining'] = admin.firestore.FieldValue.increment(1);
    await db.collection('users').doc(reservation.uid).update(patch);
  } catch (e) { console.error('coupon refund fail', e); }
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

// ★ 구조화 출력용 tool 정의 (JSON.parse 대신 tool_use로 안전하게 객체 수신)
// ★ mode별 스키마 분기: assignment만 의문문/접속사/P3/문단비율 필드 강제
function buildHumanizeTool(mode) {
  const baseProperties = {
    outputText: { type: 'string', description: '변환된 글 전체' },
    summary:    { type: 'string', description: '변환 요약 2문장. 존댓말(~입니다/~합니다체)로 작성.' },
    detail:     { type: 'string', description: '적용한 기법 상세. 존댓말(~입니다/~합니다체)로 작성.' },
    topNounCounts: {
      type: 'object',
      description: 'outputText에서 가장 많이 등장하는 주제어(명사) 상위 3개와 횟수. 예: {"배출":2,"정부":1}. 어떤 값도 4 이상이면 규칙 7 위반 — 재작성',
      additionalProperties: { type: 'integer' }
    },
    listOfThreeCount: {
      type: 'integer',
      description: '콤마/쉼표/"와"/"이나"로 3개 이상 묶은 나열 문장 수. 반드시 0 (규칙 8, AI 시그니처)'
    },
    consecutiveNounSubjectMax: {
      type: 'integer',
      description: '명사 주어로 시작하는 문장의 최대 연속 개수. 2 이하 (규칙 9)'
    },
    shortSentenceRatio: {
      type: 'number',
      description: '15자 이하 단문 수 / 전체 문장 수. 0.20 이상 (P2)'
    },
    hedgeRatio: {
      type: 'number',
      description: '추정 어미("~인 것 같다","~라고 생각한다","~던 것 같다") 사용 문장 / 전체 문장. 0.10 이상 0.15 이하 (규칙 5)'
    },
    selfCheckPass: {
      type: 'boolean',
      description: '위 임계를 전부 통과했을 때만 true. 하나라도 위반이면 false'
    }
  };
  const baseRequired = [
    'outputText', 'summary', 'detail',
    'topNounCounts', 'listOfThreeCount', 'consecutiveNounSubjectMax',
    'shortSentenceRatio', 'hedgeRatio', 'selfCheckPass'
  ];

  if (mode === 'assignment') {
    baseProperties.questionSentenceCount = {
      type: 'integer',
      description: '의문문("?"로 끝) 개수. 1 이상 (규칙 9)'
    };
    baseProperties.conjunctionStartRatio = {
      type: 'number',
      description: '접속사/전환어구(따라서/그러므로/결국/결론적으로/이를 위해/이런 흐름 속에서/한편/또한/그런데/그래서/사실 등)로 시작하는 문장 수 / 전체 문장. 0.15 이하 (규칙 2)'
    };
    baseProperties.lastSentenceIsReassurance = {
      type: 'boolean',
      description: '마지막 문장이 재보증/요약/평가 패턴("~할 필요가 있다","~에 달려 있다","~얘기다","정리하자면","결론적으로","알게 됩니다","깨닫게 됩니다")이면 true. false여야 통과 (P3)'
    };
    baseProperties.paragraphLengthRatio = {
      type: 'number',
      description: '(가장 긴 문단의 문장 수) / (가장 짧은 문단의 문장 수). 2 이상 (규칙 6). 문단이 1개면 -1로 보고하여 검증 skip'
    };
    baseProperties.commaClauseRatio = {
      type: 'number',
      description: '쉼표 포함 + 종결/연결어미(다/니다/며/고/어서/아서/면서/는데/지만 등)가 2개 이상인 문장 / 전체. 0.30 이하 (P1). 서버 실측으로 덮어씀.'
    };
    baseProperties.shortRunWithoutComma = {
      type: 'integer',
      description: '쉼표 없는 평서문 3연속 구간 개수. 1 이상 (P1). 서버 실측으로 덮어씀.'
    };
    baseProperties.tinySentenceCount = {
      type: 'integer',
      description: '8자 이하 초단문 개수(공백 제외). 2 이상 (P2). 서버 실측으로 덮어씀.'
    };
    baseProperties.longShortAdjacencyCount = {
      type: 'integer',
      description: '40자+ 장문 바로 뒤에 10자 이하 단문이 오는 경우 수. 1 이상 (P2). 서버 실측으로 덮어씀.'
    };
    baseProperties.sameEndingRun = {
      type: 'integer',
      description: '같은 종결어미(습니다/됩니다/있습니다 등)로 연속 종결된 최대 문장 수. 2 이하 (규칙 2). 서버 실측으로 덮어씀.'
    };
    baseProperties.similarLengthRun = {
      type: 'integer',
      description: '한 문단 내 ±5자 이내 문장 길이 연속 최대치(15자 이상 문장만 판정). 2 이하 (규칙 6). 서버 실측으로 덮어씀.'
    };
    baseProperties.spellingIssues = {
      type: 'array',
      description: '맞춤법/띄어쓰기 블랙리스트 적중 목록. 빈 배열이어야 통과 (P0). 서버 실측으로 덮어씀.',
      items: { type: 'string' }
    };
    baseRequired.push(
      'questionSentenceCount', 'conjunctionStartRatio',
      'lastSentenceIsReassurance', 'paragraphLengthRatio',
      'commaClauseRatio', 'shortRunWithoutComma',
      'tinySentenceCount', 'longShortAdjacencyCount',
      'sameEndingRun', 'similarLengthRun', 'spellingIssues'
    );
  }

  return {
    name: 'return_humanized_result',
    description: '재작성된 텍스트와 셀프체크 수치를 반환한다. 수치는 outputText를 실제로 세어 채운다 (추정 금지).',
    input_schema: {
      type: 'object',
      properties: baseProperties,
      required: baseRequired
    }
  };
}

const DETECT_TOOL = {
  name: 'return_detection_result',
  description: 'AI 생성 확률 판정 결과를 반환한다.',
  input_schema: {
    type: 'object',
    properties: {
      probability: { type: 'number', description: '0~100 사이 AI 생성 확률' },
      summary:     { type: 'string', description: '핵심 판단 이유 1~2문장. 존댓말(~입니다/~합니다체)로 작성.' },
      detail:      { type: 'string', description: '상세 분석 100자 이상. 존댓말(~입니다/~합니다체)로 작성.' }
    },
    required: ['probability', 'summary', 'detail']
  }
};

function extractToolResult(data, toolName) {
  const toolUse = data.content && data.content.find(c => c.type === 'tool_use' && c.name === toolName);
  if (!toolUse) throw new Error('모델이 구조화 응답을 반환하지 않았습니다.');
  return toolUse.input;
}

// ★ 모델의 자기보고를 신뢰하지 않고 서버가 직접 실측. 실측 > 보고면 덮어쓰고 selfCheckPass를 재계산.
//   assignment 모드는 접속사 시작 비율/P3 마지막 문장/주제어 빈도/문단 비율까지 서버에서 추가 실측.
function verifyCheckFields(result, mode, inputParaCount) {
  const text = result.outputText || '';

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

    // 접속사/전환어구 시작 실측
    const connectorRe = /^(따라서|그러므로|즉|결국|결론적으로|궁극적으로|이를 위해|이런 흐름 속에서|이러한|한편|또한|게다가|그런데|그래서|사실|물론|그렇다고|하지만|반면|반면에|아울러)\b/;
    const connectorStarts = sentences.filter(s => connectorRe.test(s)).length;
    const actualConjRatio = sentences.length > 0 ? connectorStarts / sentences.length : 0;
    if (actualConjRatio > (result.conjunctionStartRatio || 0)) {
      overrides.push(`conjunctionStartRatio ${(result.conjunctionStartRatio || 0).toFixed(2)} → ${actualConjRatio.toFixed(2)}`);
      result.conjunctionStartRatio = actualConjRatio;
    }

    // P3 마지막 문장 재보증/평가 패턴 실측 (교훈형 일반화 마무리 포함)
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

    // 문단 비율 실측: \n{2,}로 문단 분리 후 문장 수 기준 max/min
    const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    if (paragraphs.length >= 2) {
      const sentCounts = paragraphs.map(p => {
        const ps = p.split(/(?<=[.!?？。])\s+|\n+/).map(s => s.trim()).filter(Boolean);
        return ps.length || 1;
      });
      const maxS = Math.max(...sentCounts);
      const minS = Math.min(...sentCounts);
      const actualRatio = minS > 0 ? maxS / minS : 1;
      if (actualRatio < (result.paragraphLengthRatio || Infinity)) {
        overrides.push(`paragraphLengthRatio ${result.paragraphLengthRatio} → ${actualRatio.toFixed(2)}`);
        result.paragraphLengthRatio = actualRatio;
      }
    } else if (result.paragraphLengthRatio !== -1) {
      // 문단 1개면 검증 skip sentinel
      result.paragraphLengthRatio = -1;
    }

    // 문단 수 일치 실측: 입력 문단 수 vs 출력 문단 수
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

    // ===== 규칙 2: 동일 종결어미 연속 =====
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

    // ===== 규칙 6: 문단별 ±5자 이내 문장 길이 3연속 (15자 이상만 판정) =====
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

    // ===== 규칙 9: 명사 주어 연속 실측 (모델 자기보고 덮어쓰기) =====
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

    // ===== 규칙 5: hedgeRatio 양방향 실측 (상하한 0.10~0.15 때문에 절대값 오차로 교정) =====
    const hedgeRe = /(인 것 같|라고 생각|던 것 같|았던 것 같|았을지도|일지도 모|일 수도 있|인 듯)/;
    const hedgeCount = sentences.filter(s => hedgeRe.test(s)).length;
    const actualHedge = sentences.length > 0 ? hedgeCount / sentences.length : 0;
    if (Math.abs(actualHedge - (result.hedgeRatio || 0)) > 0.03) {
      overrides.push(`hedgeRatio ${(result.hedgeRatio || 0).toFixed(2)} → ${actualHedge.toFixed(2)}`);
      result.hedgeRatio = actualHedge;
    }

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
      { re: /(된|한|할|할|쓴|본|들은|만든|받은|배운|찾은|준)걸(\s|$|[.,!?])/, msg: '~ㄴ걸→~ㄴ 걸' }
    ];
    const spellIssues = spellingRules.filter(r => r.re.test(text)).map(r => r.msg);
    if (spellIssues.length > (result.spellingIssues?.length || 0)) {
      overrides.push(`spellingIssues ${(result.spellingIssues || []).length} → ${spellIssues.length}`);
      result.spellingIssues = spellIssues;
    }
  }

  // 임계 기준으로 selfCheckPass 재계산 (collectFailedFields와 동일 기준)
  let violations =
    (result.topNounCounts && Object.values(result.topNounCounts).some(n => n >= 4)) ||
    result.listOfThreeCount >= 1 ||
    result.consecutiveNounSubjectMax >= 3 ||
    (typeof result.shortSentenceRatio === 'number' && result.shortSentenceRatio < 0.20) ||
    (typeof result.hedgeRatio === 'number' && (result.hedgeRatio < 0.10 || result.hedgeRatio > 0.15));

  if (mode === 'assignment') {
    violations = violations
      || (typeof result.conjunctionStartRatio === 'number' && result.conjunctionStartRatio > 0.15)
      || result.lastSentenceIsReassurance === true
      || (result.questionSentenceCount || 0) === 0
      || (typeof result.paragraphLengthRatio === 'number'
          && result.paragraphLengthRatio >= 0
          && result.paragraphLengthRatio < 2)
      || !!result.paragraphCountMismatch
      || (typeof result.commaClauseRatio === 'number' && result.commaClauseRatio > 0.30)
      || (result.shortRunWithoutComma || 0) < 1
      || (result.tinySentenceCount || 0) < 2
      || (result.longShortAdjacencyCount || 0) < 1
      || (result.sameEndingRun || 0) >= 3
      || (result.similarLengthRun || 0) >= 3
      || (Array.isArray(result.spellingIssues) && result.spellingIssues.length > 0);
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
function shouldRefine(result, mode) {
  const critical =
    (result.topNounCounts && Object.values(result.topNounCounts).some(n => n >= 4))
    || (result.listOfThreeCount || 0) >= 1
    || (Array.isArray(result.spellingIssues) && result.spellingIssues.length > 0)
    || (mode === 'assignment' && !!result.paragraphCountMismatch)
    || (mode === 'assignment' && result.lastSentenceIsReassurance === true);
  if (critical) return { refine: true, reason: 'critical' };

  let minor = 0;
  if (typeof result.shortSentenceRatio === 'number' && result.shortSentenceRatio < 0.15) minor++;
  if (typeof result.hedgeRatio === 'number' && (result.hedgeRatio < 0.07 || result.hedgeRatio > 0.18)) minor++;
  if ((result.consecutiveNounSubjectMax || 0) >= 4) minor++;
  if (mode === 'assignment') {
    if (typeof result.conjunctionStartRatio === 'number' && result.conjunctionStartRatio > 0.20) minor++;
    if (typeof result.commaClauseRatio === 'number' && result.commaClauseRatio > 0.40) minor++;
    if ((result.sameEndingRun || 0) >= 4) minor++;
    if ((result.similarLengthRun || 0) >= 4) minor++;
  }
  return { refine: minor >= 5, reason: minor >= 5 ? `minor x${minor}` : 'pass' };
}

// 셀프체크 수치를 임계와 대조해 위반된 항목을 사람이 읽을 문장으로 반환
function collectFailedFields(r, mode) {
  const failed = [];
  if (r.topNounCounts && Object.values(r.topNounCounts).some(n => n >= 4)) {
    const over = Object.entries(r.topNounCounts).filter(([, n]) => n >= 4).map(([k, n]) => `"${k}" ${n}회`).join(', ');
    failed.push(`주제어 4회 이상 반복(규칙 7): ${over} — 지시어/유의어로 교체`);
  }
  if (r.listOfThreeCount >= 1) {
    failed.push(`3개 이상 나열 ${r.listOfThreeCount}건(규칙 8, AI 시그니처) — 별도 문장으로 분리`);
  }
  if (r.consecutiveNounSubjectMax >= 3) {
    failed.push(`명사 주어 ${r.consecutiveNounSubjectMax}연속(규칙 9) — 중간 문장을 부사/접속사/지시어로 시작`);
  }
  if (typeof r.shortSentenceRatio === 'number' && r.shortSentenceRatio < 0.20) {
    failed.push(`15자 이하 단문 비율 ${(r.shortSentenceRatio * 100).toFixed(0)}%(P2, 목표 20%+) — 긴 문장을 쪼개라`);
  }
  if (typeof r.hedgeRatio === 'number' && (r.hedgeRatio < 0.10 || r.hedgeRatio > 0.15)) {
    failed.push(`추정 어미 비율 ${(r.hedgeRatio * 100).toFixed(0)}%(규칙 5, 목표 10~15%) — 조정`);
  }
  if (mode === 'assignment') {
    if (typeof r.conjunctionStartRatio === 'number' && r.conjunctionStartRatio > 0.15) {
      failed.push(`접속사/전환어구 시작 ${(r.conjunctionStartRatio * 100).toFixed(0)}%(규칙 2, 목표 15% 이하) — '사실/이런 흐름 속에서/이를 위해/그런데/그래서/결국' 같은 시작을 본문 중간 부사·지시어로 교체`);
    }
    if (r.lastSentenceIsReassurance === true) {
      failed.push(`마지막 문장이 재보증/평가(P3 위반) — '~할 필요가 있다/~에 달려 있다/~지속가능한지는' 대신 구체 사례·미해결 질문·관찰로 닫아라`);
    }
    if ((r.questionSentenceCount || 0) === 0) {
      failed.push(`의문문 0건(규칙 9, 최소 1건) — 주장 중 하나를 '정말 ~일까?' 같은 의문형으로 전환`);
    }
    if (typeof r.paragraphLengthRatio === 'number'
        && r.paragraphLengthRatio >= 0
        && r.paragraphLengthRatio < 2) {
      failed.push(`문단 길이 비대칭 부족 (비율 ${r.paragraphLengthRatio.toFixed(2)}, 규칙 6, 목표 1:2 이상) — 짧은 문단은 1~2문장으로, 긴 문단은 4문장 이상으로 차이를 벌려라`);
    }
    if (r.paragraphCountMismatch) {
      failed.push(`문단 수 불일치: 입력 ${r.paragraphCountMismatch.input}문단 → 출력 ${r.paragraphCountMismatch.output}문단. 원문의 문단 수를 그대로 유지하라. \\n\\n을 추가/삭제하지 말 것.`);
    }
    if (typeof r.commaClauseRatio === 'number' && r.commaClauseRatio > 0.30) {
      failed.push(`쉼표 복문 비율 ${(r.commaClauseRatio * 100).toFixed(0)}%(P1, 목표 30% 이하) — 쉼표로 이어붙인 긴 문장을 마침표로 끊어 독립 문장으로 재배치`);
    }
    if ((r.shortRunWithoutComma || 0) < 1) {
      failed.push(`쉼표 없는 3문장 연속 구간 0회(P1, 최소 1회) — 쉼표 없이 짧은 단정문이 3개 이어지는 구간을 1회 이상 만들어라`);
    }
    if ((r.tinySentenceCount || 0) < 2) {
      failed.push(`8자 이하 초단문 ${r.tinySentenceCount || 0}개(P2, 최소 2개) — "그게 전부입니다." "숫자가 말해줍니다." 같은 초단문 추가`);
    }
    if ((r.longShortAdjacencyCount || 0) < 1) {
      failed.push(`장문(40자+) 뒤 단문(10자-) 인접 0회(P2, 최소 1회) — 긴 문장 직후에 10자 이하 단문 배치`);
    }
    if ((r.sameEndingRun || 0) >= 3) {
      failed.push(`동일 종결어미 ${r.sameEndingRun}연속(규칙 2) — 3번째 문장을 의문형/추정형("~것 같습니다")/경험형으로 교체`);
    }
    if ((r.similarLengthRun || 0) >= 3) {
      failed.push(`문장 길이 ±5자 ${r.similarLengthRun}연속(규칙 6) — 중간 문장을 대폭 줄이거나 늘려서 리듬 파괴`);
    }
    if (Array.isArray(r.spellingIssues) && r.spellingIssues.length > 0) {
      failed.push(`맞춤법/띄어쓰기 오류(P0): ${r.spellingIssues.join(', ')} — 해당 표기 교정`);
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

async function callClaude(messages, tools, temperature, system, options = {}) {
  const body = {
    model: options.model || MODEL,
    max_tokens: options.maxTokens || 8192,
    messages: messages
  };

  if (tools) body.tools = tools;
  if (options.toolChoice) body.tool_choice = options.toolChoice;
  if (temperature !== undefined) body.temperature = temperature;

  // ★ 시스템 프롬프트에 cache_control 적용 (고정 프롬프트가 캐싱됨)
  if (system) {
    body.system = [
      {
        type: "text",
        text: system,
        cache_control: { type: "ephemeral" }
      }
    ];
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (data.usage) {
    console.log("-----------------------------------------");
    console.log(`📊 비용 리포트: 캐시읽기(90%할인) ${data.usage.cache_read_input_tokens || 0} / 캐시생성(25%추가) ${data.usage.cache_creation_input_tokens || 0} / 일반입력 ${data.usage.input_tokens || 0}`);
    console.log("-----------------------------------------");
  }

  if (data.stop_reason === 'max_tokens') {
    console.log('⚠️ 응답이 max_tokens 제한으로 잘림');
  }

  return data;
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

  let reserved;
  try {
    if (billingMode === 'coupon') {
      reserved = await verifyAndReserveCoupon(idToken, text.length, opType);
    } else {
      reserved = await verifyAndReserveCredits(idToken, needed, opType);
    }
  } catch (e) {
    return res.status(e.status || 500).json({
      error: authErrorMessage(e.message),
      ...(e.charLimit !== undefined ? { charLimit: e.charLimit } : {})
    });
  }

  try {
    // ★ 감지: tool_use로 구조화 응답 수신 (JSON.parse 실패 원천 차단)
    if (mode === 'detect') {
      const detectUserContent = prevContext
        ? `[앞 청크의 마지막 일부 — 문맥 참고용, 이 부분은 점수에 포함하지 말 것]\n${prevContext}\n\n[분석할 글]\n${text}`
        : `[분석할 글]\n${text}`;
      const data = await callClaude(
        [{ role: 'user', content: detectUserContent }],
        [DETECT_TOOL], undefined,
        getDetectSystem(lang),
        { model: MODEL, maxTokens: 2048, toolChoice: { type: 'tool', name: DETECT_TOOL.name } }
      );
      const result = extractToolResult(data, DETECT_TOOL.name);
      return res.json({ ok: true, result, usage: data.usage });
    }

    // 웹 검색 (유저가 활성화한 경우에만 실행)
    let examples = null;
    if (req.body.webSearch) {
      try {
        const searchPrompt = lang === 'en'
          ? `Identify the topic of the following text and briefly provide 2-3 specific real-world examples or statistics related to it. Text: ${text.substring(0, 500)}`
          : `다음 글의 주제를 파악하고, 관련된 구체적인 실제 사례나 통계를 2~3개 간략히 제시해줘. 글: ${text.substring(0, 500)}`;
        const searchData = await callClaude(
          [{ role: 'user', content: searchPrompt }],
          [{ type: 'web_search_20250305', name: 'web_search' }]
        );
        const textContent = searchData.content.filter(c => c.type === 'text').map(c => c.text).join('');
        if (textContent.length > 50) examples = textContent.substring(0, 800);
      } catch(e) {}
    }

    // ★ 휴머나이저: 고정 프롬프트는 system(캐싱), 유저 텍스트만 user 메시지
    const selectedMode = req.body.humanizeMode || 'assignment';
    const humanizeSystem = getHumanizeSystem(selectedMode, lang);
    const humanizeTool = buildHumanizeTool(selectedMode);
    const prevContextBlock = prevContext
      ? `[앞 청크의 마지막 일부 — 문체 연속성 참고용, 다시 변환하지 말 것]\n${prevContext}\n\n`
      : '';
    const userContent = examples
      ? `${prevContextBlock}[재작성할 텍스트]\n${text}\n\n[참고할 실제 사례/통계 (자연스럽게 녹여 활용)]\n${examples}`
      : `${prevContextBlock}[재작성할 텍스트]\n${text}`;
    const inputParaCount = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean).length;

    const data = await callClaude(
      [{ role: 'user', content: userContent }],
      [humanizeTool], 0.9,
      humanizeSystem,
      { maxTokens: 16384, toolChoice: { type: 'tool', name: humanizeTool.name } }
    );
    let result = extractToolResult(data, humanizeTool.name);
    verifyCheckFields(result, selectedMode, inputParaCount);

    // ★ 2-pass 폴백: critical 위반 1건 또는 minor 2건+일 때만 재호출 (비용 절약)
    let refineUsage = null;
    const refineDecision = shouldRefine(result, selectedMode);
    if (refineDecision.refine) {
      const failed = collectFailedFields(result, selectedMode);
      console.log(`⚠️ 2-pass 발동 [${refineDecision.reason}]. 위반: ${failed.join(' | ')}`);
      const refineUser = `[이전 출력]\n${result.outputText}\n\n[위반 항목]\n${failed.join('\n')}\n\n위반된 부분만 최소 수정하라. 다른 문장은 그대로 유지. 새로운 흐름 꺾기 한정어·메타 사색·종결 어미 변형을 추가하지 마라(추가하면 정형성이 짙어져 디텍터에 더 잘 잡힌다). 수정 후 체크리스트 수치를 실제로 다시 세서 채워라.`;
      const refineData = await callClaude(
        [{ role: 'user', content: refineUser }],
        [humanizeTool], 0.9,
        humanizeSystem,
        { maxTokens: 16384, toolChoice: { type: 'tool', name: humanizeTool.name } }
      );
      result = extractToolResult(refineData, humanizeTool.name);
      verifyCheckFields(result, selectedMode, inputParaCount);
      refineUsage = refineData.usage;
      if (result.selfCheckPass === false) {
        console.log(`⚠️ 2-pass 후에도 selfCheckPass=false. 결과 그대로 반환.`);
      }
    }

    if (result.outputText) result.outputText = cleanText(result.outputText);

    res.json({ ok: true, result, usage: data.usage, refineUsage });

  } catch (err) {
    if (reserved?.billingMode === 'coupon') {
      await refundCoupon(reserved);
    } else if (reserved) {
      await refundCredits(reserved.uid, reserved.reserved);
    }
    console.error('/analyze LLM error:', err && err.message);
    res.status(500).json({ error: '처리 중 오류가 발생했습니다.' });
  }
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

  let reserved;
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

  try {
    if (billingMode === 'coupon') {
      reserved = await verifyAndReserveCoupon(idToken, pdfText.length, opType);
    } else {
      reserved = await verifyAndReserveCredits(idToken, needed, opType);
    }
  } catch (e) {
    return res.status(e.status || 500).json({
      error: authErrorMessage(e.message),
      ...(e.charLimit !== undefined ? { charLimit: e.charLimit } : {})
    });
  }

  try {
    const text = pdfText;

    const humanizeModePdf = req.body.humanizeMode || 'assignment';
    const systemPrompt = mode === 'detect' ? getDetectSystem(lang) : getHumanizeSystem(humanizeModePdf, lang);
    const userContent = mode === 'detect' ? `[분석할 글]\n${text}` : `[재작성할 텍스트]\n${text}`;
    const activeTool = mode === 'detect' ? DETECT_TOOL : buildHumanizeTool(humanizeModePdf);
    const pdfOptions = mode === 'detect'
      ? { model: MODEL, maxTokens: 2048, toolChoice: { type: 'tool', name: DETECT_TOOL.name } }
      : { maxTokens: 16384, toolChoice: { type: 'tool', name: activeTool.name } };
    const data = await callClaude(
      [{ role: 'user', content: userContent }],
      [activeTool], undefined,
      systemPrompt,
      pdfOptions
    );
    const result = extractToolResult(data, activeTool.name);
    if (result.outputText) result.outputText = cleanText(result.outputText);

    res.json({
      ok: true,
      result,
      usage: data.usage,
      extractedText: text.substring(0, 500)
    });
  } catch (err) {
    if (reserved?.billingMode === 'coupon') {
      await refundCoupon(reserved);
    } else if (reserved) {
      await refundCredits(reserved.uid, reserved.reserved);
    }
    console.error('/analyze-pdf LLM error:', err && err.message);
    res.status(500).json({ error: '처리 중 오류가 발생했습니다.' });
  }
});

router.verifyCheckFields = verifyCheckFields;
router.collectFailedFields = collectFailedFields;
module.exports = router;
