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
function buildHumanizeTool(mode) {
  // ★ JSON-CoT 베스트 프랙티스(ACL submission + Pockit/Collin Wilkins 2026): reasoning 필드를 answer 필드 앞에 둠.
  //   reasoning before answer → +60% 정확도 (GSM8k 측정), 모델이 답을 선커밋한 뒤 사후 합리화하는 우회 차단.
  //   plan 필드를 outputText 앞에 두어 모델이 글 작성 *전*에 룰 적용 계획을 명시하게 한다.
  const baseProperties = {
    plan: {
      type: 'string',
      description: '글 작성 전 필수 적용 계획. 다음 5개 항목을 1문장씩 명시: (1) 입력 글에 등장한 통계·연도·고유명사·기관명을 모두 나열하고, 출력에서 그대로 유지할 항목만 표시. 입력에 없는 새 통계·연도·고유명사는 절대 추가하지 않는다고 선언. (2) 위 예시 글의 어휘를 그대로 베끼지 않고 톤·구조·hedge 분포만 모방한다고 선언. (3) 시스템 프롬프트의 P0과 룰 1~12 중 이 글에 가장 위험한 룰 3개 식별. (4) 원문 흐름이 전형 프레임이면 재배치 방향. (5) **자연 흐름 우선**: 정보를 한 문장에 압축하지 않고, 문장 사이를 자연 연결 어구(그래서/그런데/다만/물론/결국)로 매끄럽게 잇는다고 선언. 룰 충족이 단절감을 만들면 안 됨. 5~7문장.'
    },
    outputText: { type: 'string', description: '변환된 글 전체. plan에 명시한 계획대로 작성.' },
    summary:    { type: 'string', description: '변환 요약 2문장. 존댓말(~입니다/~합니다체)로 작성.' },
    detail:     { type: 'string', description: '적용한 기법 상세. 존댓말(~입니다/~합니다체)로 작성.' },
    topNounCounts: {
      type: 'object',
      description: 'outputText에서 가장 많이 등장하는 주제어(명사) 상위 3개와 횟수. 예: {"배출":2,"정부":1}. 어떤 값도 4 이상이면 룰 7(어휘 다양화) 위반 — 재작성',
      additionalProperties: { type: 'integer' }
    },
    listOfThreeCount: {
      type: 'integer',
      description: '콤마/쉼표/"와"/"이나"로 3개 이상 묶은 나열 문장 수. 반드시 0 (룰 4 콤마 절 누적 금지, AI 시그너처)'
    },
    consecutiveNounSubjectMax: {
      type: 'integer',
      description: '명사 주어로 시작하는 문장의 최대 연속 개수. 2 이하 (룰 3 비명사 시작)'
    },
    shortSentenceRatio: {
      type: 'number',
      description: '15자 이하 단문 수 / 전체 문장 수. 0.20 이상 (P2)'
    },
    hedgeRatio: {
      type: 'number',
      description: '추정 어미("~인 것 같다","~라고 생각한다","~던 것 같다") 사용 문장 / 전체 문장. 인간 분포 0.10~0.20 (룰 6 hedge 풀세트). 한국어 카피킬러는 hedge를 인간 시그너처로 학습 — 권장 분량 자연스럽게 배치.'
    },
    selfCheckPass: {
      type: 'boolean',
      description: '위 임계를 전부 통과했을 때만 true. 하나라도 위반이면 false'
    }
  };
  const baseRequired = [
    'plan', 'outputText', 'summary', 'detail',
    'topNounCounts', 'listOfThreeCount', 'consecutiveNounSubjectMax',
    'shortSentenceRatio', 'hedgeRatio', 'selfCheckPass'
  ];

  if (mode === 'assignment') {
    baseProperties.questionSentenceCount = {
      type: 'integer',
      description: '의문문("?"로 끝) 개수. 1~3건 권장 (룰 1 변형 종결 ~까요? + 룰 6 의문문 보조 0~1회 정합). 0건도 위반 아님.'
    };
    baseProperties.conjunctionStartRatio = {
      type: 'number',
      description: '접속사/전환어구(따라서/그러므로/결국/결론적으로/이를 위해/이런 흐름 속에서/한편/또한/그런데/그래서/사실 등)로 시작하는 문장 수 / 전체 문장. 0.15 이하 (룰 3 사고흐름 표지 — 권장하지만 남발 금지)'
    };
    baseProperties.lastSentenceIsReassurance = {
      type: 'boolean',
      description: '마지막 문장이 재보증/요약/평가 패턴("~할 필요가 있다","~에 달려 있다","~얘기다","정리하자면","결론적으로","알게 됩니다","깨닫게 됩니다")이면 true. false여야 통과 (P3)'
    };
    baseProperties.paragraphLengthRatio = {
      type: 'number',
      description: '(가장 긴 문단의 문장 수) / (가장 짧은 문단의 문장 수). 2 이상 (룰 10 문단 자연 분리). 문단이 1개면 -1로 보고하여 검증 skip'
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
      description: '같은 종결어미(습니다/됩니다/있습니다 등)로 연속 종결된 최대 문장 수. 2 이하 (룰 1 종결어미 다양화 — 4문장 연속 금지). 서버 실측으로 덮어씀.'
    };
    baseProperties.similarLengthRun = {
      type: 'integer',
      description: '한 문단 내 ±5자 이내 문장 길이 연속 최대치(15자 이상 문장만 판정). 2 이하 (룰 2 문장 길이). 서버 실측으로 덮어씀.'
    };
    baseProperties.spellingIssues = {
      type: 'array',
      description: '맞춤법/띄어쓰기 블랙리스트 적중 목록. 빈 배열이어야 통과 (P0). 서버 실측으로 덮어씀.',
      items: { type: 'string' }
    };
    baseProperties.evidenceCount = {
      type: 'integer',
      description: '사례·인용 문장 수. "[연도(YYYY)+주체+수치/기업명]" 형태로 객관 사실을 인용한 문장 개수. 서버 실측으로 덮어씀.'
    };
    baseProperties.evidenceWithoutInterpretation = {
      type: 'integer',
      description: '사례 문장 직후 글쓴이 해석/판단/의문 문장이 따라붙지 않은 케이스 수. 0이어야 통과 (절대 금지 1항 안전망). 서버 실측으로 덮어씀.'
    };
    baseProperties.evidencePerParagraphMax = {
      type: 'integer',
      description: '한 단락 안에 등장하는 사례 인용 최대 개수. 2 이하 (절대 금지 1항 안전망). 서버 실측으로 덮어씀.'
    };
    baseProperties.topicFocusRatio = {
      type: 'number',
      description: '입력이 다항목 주제(ESG의 E/S/G, N분야 등)일 때 가장 비중 큰 sub-topic의 분량 비율(0~1). 0.5 이상 (룰 11 균등 전개 금지). 다항목 아니면 -1로 보고하여 검증 skip.'
    };
    baseRequired.push(
      'questionSentenceCount', 'conjunctionStartRatio',
      'lastSentenceIsReassurance', 'paragraphLengthRatio',
      'commaClauseRatio', 'shortRunWithoutComma',
      'tinySentenceCount', 'longShortAdjacencyCount',
      'sameEndingRun', 'similarLengthRun', 'spellingIssues',
      'evidenceCount', 'evidenceWithoutInterpretation',
      'evidencePerParagraphMax', 'topicFocusRatio'
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
function getDetectTool() {
  return DETECT_TOOL;
}
function getHumanizeToolFor(mode) {
  return buildHumanizeTool(mode);
}

// ★ 모델의 자기보고를 신뢰하지 않고 서버가 직접 실측. 실측 > 보고면 덮어쓰고 selfCheckPass를 재계산.
//   assignment 모드는 접속사 시작 비율/P3 마지막 문장/주제어 빈도/문단 비율까지 서버에서 추가 실측.
function verifyCheckFields(result, mode, inputParaCount, inputCharLen) {
  const text = result.outputText || '';

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

    // 수사적 의문문 카운트 — 룰 6 강행 규정 "수사적 의문문 0회"
    // LLM이 negative instruction 못 따르는 한계 보완. 0보다 크면 critical violation.
    const rhetoricalRe = /(까요|일까요|이지\s*않을까요|않을까요|아닐까요|아닐지요|이지\s*않은가요|그럴까요|과장일까요|아닐까)\?/g;
    const rhetoricalMatches = text.match(rhetoricalRe) || [];
    const actualRhetorical = rhetoricalMatches.length;
    if (actualRhetorical !== (result.rhetoricalQuestionCount || 0)) {
      overrides.push(`rhetoricalQuestionCount ${result.rhetoricalQuestionCount} → ${actualRhetorical}`);
      result.rhetoricalQuestionCount = actualRhetorical;
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
      { re: /(빠질|할|볼|쓸|올|갈|줄|얻을|받을|만날|보낼|읽을)수\s/, msg: '~ㄹ수→~ㄹ 수' }
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
  }

  // 임계 기준으로 selfCheckPass 재계산 (collectFailedFields와 동일 기준)
  let violations =
    (result.topNounCounts && Object.values(result.topNounCounts).some(n => n >= 4)) ||
    result.listOfThreeCount >= 1 ||
    result.consecutiveNounSubjectMax >= 3 ||
    (typeof result.shortSentenceRatio === 'number' && result.shortSentenceRatio < 0.20);
    // hedgeRatio 위반 폐기 (사용자 0% 통과 글 hedgeRatio 16.7% — 인간 분포가 5~20%).
    // 한국어 카피킬러는 hedge·관찰형 종결을 인간 시그너처로 학습. 우리 룰 6 가정 정면 반대.

  if (mode === 'assignment') {
    violations = violations
      || (typeof result.conjunctionStartRatio === 'number' && result.conjunctionStartRatio > 0.15)
      || result.lastSentenceIsReassurance === true
      // rhetoricalQuestionCount > 0 위반 폐기 (사용자 0% AFTER 실측: 수사적 의문문 2건 정상)
      // hedge·rhetorical은 한국어 카피킬러에서 인간 시그너처. 우리 룰 6 가정이 정면 반대였음.
      || (result.declarativeDefinitionCount || 0) >= 3
      || (result.evidenceCount || 0) >= 4
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
      || (Array.isArray(result.spellingIssues) && result.spellingIssues.length > 0)
      || !!result.lengthShortfall
      || (result.evidenceWithoutInterpretation || 0) >= 1
      || (result.evidencePerParagraphMax || 0) >= 3
      || (typeof result.topicFocusRatio === 'number'
          && result.topicFocusRatio >= 0
          && result.topicFocusRatio < 0.5);
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
    || (mode === 'assignment' && result.lastSentenceIsReassurance === true)
    // rhetoricalQuestionCount > 0 critical 폐기 (사용자 0% AFTER 실측: 2건 정상)
    || (mode === 'assignment' && (result.declarativeDefinitionCount || 0) >= 3)
    || (mode === 'assignment' && (result.evidenceCount || 0) >= 4)
    || (mode === 'assignment' && (result.evidenceWithoutInterpretation || 0) >= 1)
    || (mode === 'assignment' && (result.evidencePerParagraphMax || 0) >= 3)
    || !!result.lengthShortfall;
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
    if (typeof result.topicFocusRatio === 'number' && result.topicFocusRatio >= 0 && result.topicFocusRatio < 0.4) minor++;
    // evidenceCount >= 4 는 critical로 격상됨(O2). minor 트리거에선 제거.
    if ((result.questionSentenceCount || 0) === 0) minor++;
  }
  return { refine: minor >= 5, reason: minor >= 5 ? `minor x${minor}` : 'pass' };
}

// 셀프체크 수치를 임계와 대조해 위반된 항목을 사람이 읽을 문장으로 반환
function collectFailedFields(r, mode) {
  const failed = [];
  if (r.topNounCounts && Object.values(r.topNounCounts).some(n => n >= 4)) {
    const over = Object.entries(r.topNounCounts).filter(([, n]) => n >= 4).map(([k, n]) => `"${k}" ${n}회`).join(', ');
    failed.push(`주제어 4회 이상 반복(룰 7 어휘 다양화): ${over} — 지시어/유의어로 교체`);
  }
  if (r.listOfThreeCount >= 1) {
    failed.push(`3개 이상 나열 ${r.listOfThreeCount}건(룰 4 콤마 절 누적 금지, AI 시그너처) — 별도 문장으로 분리하거나 "A부터 C까지" 같은 구간 표현으로`);
  }
  if (r.lengthShortfall) {
    const pct = (r.lengthShortfall.ratio * 100).toFixed(0);
    failed.push(`분량 부족 ${pct}% (원문 ${r.lengthShortfall.input}자 → 출력 ${r.lengthShortfall.output}자, 최소 90% 보장) — 빠뜨린 원문 디테일·예시·근거를 복원해서 분량을 늘려라. 압축·요약 금지.`);
  }
  if (r.consecutiveNounSubjectMax >= 3) {
    failed.push(`명사 주어 ${r.consecutiveNounSubjectMax}연속(룰 3 비명사 시작) — 중간 문장을 부사/접속사/지시어로 시작`);
  }
  if (typeof r.shortSentenceRatio === 'number' && r.shortSentenceRatio < 0.20) {
    failed.push(`15자 이하 단문 비율 ${(r.shortSentenceRatio * 100).toFixed(0)}%(P2, 목표 20%+) — 긴 문장을 쪼개라`);
  }
  if (typeof r.hedgeRatio === 'number' && (r.hedgeRatio < 0.10 || r.hedgeRatio > 0.15)) {
    failed.push(`추정 어미 비율 ${(r.hedgeRatio * 100).toFixed(0)}%(룰 6 hedge 풀세트, 인간 분포 10~20%) — 자연스러운 분량으로 조정. hedge는 인간 시그너처라 너무 낮으면 LLM처럼 단정적, 너무 높으면 과교정.`);
  }
  if (mode === 'assignment') {
    if (typeof r.conjunctionStartRatio === 'number' && r.conjunctionStartRatio > 0.15) {
      failed.push(`접속사/전환어구 시작 ${(r.conjunctionStartRatio * 100).toFixed(0)}%(룰 3 사고흐름 표지 — 권장하지만 남발 금지, 목표 15% 이하) — '따라서/그러므로/결론적으로' 같은 학술적 접속사 시작을 줄이고 본문 중간 부사·지시어로 분산`);
    }
    if (r.lastSentenceIsReassurance === true) {
      failed.push(`마지막 문장이 재보증/평가(P3 위반) — '~할 필요가 있다/~에 달려 있다/~지속가능한지는' 대신 구체 사례·미해결 질문·관찰로 닫아라`);
    }
    if ((r.rhetoricalQuestionCount || 0) > 0) {
      failed.push(`수사적 의문문 ${r.rhetoricalQuestionCount}건 — 룰 6 강행 규정 "수사적 의문문 글 전체 0회" 위반. '~까요?', '~지 않을까요?', '과장일까요?' 같은 자기 의견 회피 의문문은 모두 단정문으로 교체. 예: '과장일까요?' → '과장된 해석은 아닙니다.' / '~지 않을까요?' → '~지 않습니다.'`);
    }
    if ((r.questionSentenceCount || 0) === 0) {
      failed.push(`의문문 0건(룰 1 변형 종결 권장 — 1~3건 자연 배치) — 정보를 진짜로 묻는 의문문(룰 6 보조 규정) 1건 정도 추가. 수사적 의문문은 사용 가능(인간 시그너처)`);
    }
    if (typeof r.paragraphLengthRatio === 'number'
        && r.paragraphLengthRatio >= 0
        && r.paragraphLengthRatio < 2) {
      failed.push(`문단 길이 비대칭 부족 (비율 ${r.paragraphLengthRatio.toFixed(2)}, 룰 10 문단 자연 분리, 목표 1:2 이상) — 짧은 문단(2~3문장)은 더 짧게, 긴 문단(4~6문장)은 더 길게 차이를 벌려라. 단 1~2문장 문단 연속은 끊김 — 자연 흐름 우선`);
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
      failed.push(`동일 종결어미 ${r.sameEndingRun}연속(룰 1 종결어미 다양화 — 4문장 연속 금지) — 3번째 문장을 변형 종결(~까요? / ~던 것 같습니다 / ~인지도 모릅니다 / ~기도 합니다)로 교체`);
    }
    if ((r.similarLengthRun || 0) >= 3) {
      failed.push(`문장 길이 ±5자 ${r.similarLengthRun}연속(룰 2 문장 길이) — 중간 문장을 대폭 줄이거나 늘려서 리듬 파괴. 평균 30~45자 권장 + 단문(15~25자) 1개 정도로 호흡 끊기.`);
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
    if (typeof r.topicFocusRatio === 'number' && r.topicFocusRatio >= 0 && r.topicFocusRatio < 0.5) {
      failed.push(`다항목 주제를 균등 분배(최대 비중 ${(r.topicFocusRatio * 100).toFixed(0)}%, 룰 11 균등 전개 금지, 목표 50%+) — 1~2개 항목만 깊이 풀고 나머지는 1문장 이하로 압축하거나 생략. 모든 항목을 같은 패턴(정의→사례→평가)으로 풀지 마라.`);
    }
    if ((r.declarativeDefinitionCount || 0) >= 3) {
      failed.push(`단정 정의문 ${r.declarativeDefinitionCount}건 — LLM overconfidence 시그너처 직격(학술 근거: arxiv 2510.26995 LLM 84.3% overconfident, MASH 2601.08564 ASR 92%). "[고유명사]는 ~사례입니다 / ~증거입니다 / ~보여줍니다 / ~상징입니다" 같은 confident declarative 패턴이 카피킬러에 직접 잡힘. 룰 5 인용: "무생물 정의문 시작 금지. 대신 '~를 보면 / ~ 앞에 서면 / ~ 한 채에도' 같은 관찰·능동 시작으로 변환." 절반 이상을 관찰형으로 교체. 예: "엠파이어스테이트 빌딩은 그 시대 기술력의 사례입니다" → "엠파이어스테이트 빌딩을 보면 그 시대 기술력이 한눈에 들어옵니다".`);
    }
    if ((r.evidenceCount || 0) >= 4) {
      failed.push(`전체 사례 인용 ${r.evidenceCount}건(절대 금지 1항 critical, 권장 0~2건) — 사용자 카피킬러 87% 감지 실측: 사례·정량 사실이 한 글에 4건 이상 누적되면 LLM overconfidence 시그너처로 직접 잡힘. 입력 글에 없는 연도·기관명·통계는 모두 제거. 입력 사례는 추상 진술과 글쓴이 판단으로 갈아끼우고, 꼭 필요한 한두 개만 남겨라.`);
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
  { from: /(지키|만들|살|쓰|배우|찾|보|걸|구하|이해하|받아들이|판단하|결정하|해결하)는데(\s|[.,!?])/g, to: '$1는 데$2' },
  { from: /한가지(로|만|에|가|를|도|의)/g, to: '한 가지$1' },
  { from: /(일|사실|영향|결과|효과|일상|문제|역할)뿐아니라/g, to: '$1뿐 아니라' },
  { from: /(빠질|할|볼|쓸|올|갈|잘|줄|얻을|받을|만날|보낼|읽을)수\s/g, to: '$1 수 ' }
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
      const detectTool = getDetectTool();
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
      const humanizeTool = getHumanizeToolFor(selectedMode);
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
      verifyCheckFields(result, selectedMode, inputParaCount, inputCharLen);

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
        verifyCheckFields(result, selectedMode, inputParaCount, inputCharLen);
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
      const detectTool = getDetectTool();
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
      const humanizeTool = getHumanizeToolFor(humanizeModePdf);
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
