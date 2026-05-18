// [쿠폰] 관리자 일괄 발급 + 사용자 코드 적용으로 크레딧 지급
// ★ couponBatches, couponCodes 컬렉션 신설. 기존 users.coupon(구독용)과 무관.

const express = require('express');
const crypto = require('crypto');
const { admin, db, ADMIN_UIDS, verifyToken } = require('../config');

const router = express.Router();

// 32자 (0/O/1/I/L 제외) — 2^5라 randomBytes % 32 균등 분포
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;
const MAX_COUNT_PER_BATCH = 400;
const MAX_CREDITS_PER_CODE = 10000;

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CHARSET[bytes[i] & 31];
  return s;
}

function formatCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

function normalizeCode(input) {
  return String(input || '').replace(/[-\s]/g, '').toUpperCase();
}

// ───────────────────────────────────────────
// 관리자: 쿠폰 일괄 발급
// ───────────────────────────────────────────
router.post('/admin/create-coupons', async (req, res) => {
  const { idToken, credits, count, expiresAt } = req.body || {};

  const adminUid = await verifyToken(idToken);
  if (!adminUid) return res.status(401).json({ error: '로그인이 필요해요.' });
  if (!ADMIN_UIDS.includes(adminUid)) {
    return res.status(403).json({ error: '관리자 권한이 없어요.' });
  }

  const creditsInt = parseInt(credits, 10);
  const countInt = parseInt(count, 10);
  if (!Number.isInteger(creditsInt) || creditsInt < 1 || creditsInt > MAX_CREDITS_PER_CODE) {
    return res.status(400).json({ error: `크레딧은 1~${MAX_CREDITS_PER_CODE} 사이의 정수여야 해요.` });
  }
  if (!Number.isInteger(countInt) || countInt < 1 || countInt > MAX_COUNT_PER_BATCH) {
    return res.status(400).json({ error: `발급 개수는 1~${MAX_COUNT_PER_BATCH} 사이여야 해요.` });
  }

  let expiresAtTs = null;
  if (expiresAt) {
    const t = new Date(expiresAt);
    if (Number.isNaN(t.getTime())) {
      return res.status(400).json({ error: '만료일 형식이 올바르지 않아요.' });
    }
    if (t.getTime() < Date.now()) {
      return res.status(400).json({ error: '만료일은 현재 이후여야 해요.' });
    }
    expiresAtTs = admin.firestore.Timestamp.fromDate(t);
  }

  try {
    // 배치 내 중복 방지를 위한 메모리 Set
    const codes = new Set();
    while (codes.size < countInt) codes.add(generateCode());
    const codeList = Array.from(codes);

    // 외부 충돌(다른 배치와 같은 코드)이 있는지 사전 확인.
    // 32^12라 사실상 0이지만, 안전을 위해 검사.
    const refs = codeList.map(c => db.collection('couponCodes').doc(c));
    const snaps = await db.getAll(...refs);
    const collided = [];
    snaps.forEach((s, i) => { if (s.exists) collided.push(codeList[i]); });
    // 충돌한 자리는 재생성 (단순 루프, 충돌 확률 무시 가능)
    for (let i = 0; i < collided.length; i++) {
      let fresh;
      do { fresh = generateCode(); } while (codes.has(fresh));
      const idx = codeList.indexOf(collided[i]);
      codes.delete(collided[i]);
      codes.add(fresh);
      codeList[idx] = fresh;
    }

    const batchRef = db.collection('couponBatches').doc();
    const now = admin.firestore.FieldValue.serverTimestamp();

    // Firestore WriteBatch는 한 번에 500개 한도. count<=400 + batch문서 1 = 401 OK.
    const wb = db.batch();
    wb.set(batchRef, {
      adminUid,
      credits: creditsInt,
      count: countInt,
      expiresAt: expiresAtTs,
      createdAt: now
    });
    codeList.forEach(c => {
      wb.set(db.collection('couponCodes').doc(c), {
        credits: creditsInt,
        batchId: batchRef.id,
        status: 'unused',
        expiresAt: expiresAtTs,
        redeemedBy: null,
        redeemedAt: null,
        createdAt: now
      });
    });
    await wb.commit();

    console.log(`✅ 쿠폰 발급: admin=${adminUid}, ${creditsInt}크레딧 × ${countInt}개, batchId=${batchRef.id}`);

    res.json({
      ok: true,
      batchId: batchRef.id,
      credits: creditsInt,
      count: countInt,
      codes: codeList.map(c => ({ raw: c, display: formatCode(c) }))
    });
  } catch (err) {
    console.error('❌ 쿠폰 발급 실패:', err);
    res.status(500).json({ error: '쿠폰 발급 중 오류가 발생했어요.' });
  }
});

// ───────────────────────────────────────────
// 사용자: 쿠폰 코드 적용
// ───────────────────────────────────────────
router.post('/redeem-coupon', async (req, res) => {
  const { idToken, code } = req.body || {};

  const uid = await verifyToken(idToken);
  if (!uid) return res.status(401).json({ error: '로그인이 필요해요.' });

  const normalized = normalizeCode(code);
  if (normalized.length !== CODE_LENGTH) {
    return res.status(400).json({ error: '쿠폰 코드 형식이 올바르지 않아요.' });
  }

  const couponRef = db.collection('couponCodes').doc(normalized);
  const userRef = db.collection('users').doc(uid);

  try {
    const result = await db.runTransaction(async (t) => {
      // READ 먼저
      const couponSnap = await t.get(couponRef);
      if (!couponSnap.exists) {
        throw Object.assign(new Error('쿠폰 코드를 찾을 수 없어요.'), { status: 404 });
      }
      const coupon = couponSnap.data();
      if (coupon.status === 'redeemed') {
        throw Object.assign(new Error('이미 사용된 쿠폰이에요.'), { status: 409 });
      }
      if (coupon.expiresAt && coupon.expiresAt.toMillis() < Date.now()) {
        throw Object.assign(new Error('만료된 쿠폰이에요.'), { status: 410 });
      }
      const userSnap = await t.get(userRef);
      if (!userSnap.exists) {
        throw Object.assign(new Error('사용자 정보를 찾을 수 없어요.'), { status: 404 });
      }
      const currentCredits = userSnap.data().credits || 0;
      const newCredits = currentCredits + coupon.credits;

      // WRITE
      t.update(couponRef, {
        status: 'redeemed',
        redeemedBy: uid,
        redeemedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      t.update(userRef, { credits: newCredits });
      const histRef = userRef.collection('creditHistory').doc();
      t.set(histRef, {
        type: 'coupon_redeem',
        used: 0,
        amount: coupon.credits,
        remaining: newCredits,
        couponCode: normalized,
        batchId: coupon.batchId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return { granted: coupon.credits, newBalance: newCredits };
    });

    console.log(`✅ 쿠폰 사용: uid=${uid}, code=${normalized}, +${result.granted}크레딧`);
    res.json({ ok: true, credits: result.granted, newBalance: result.newBalance });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('❌ 쿠폰 사용 실패:', err);
    res.status(500).json({ error: '쿠폰 사용 중 오류가 발생했어요.' });
  }
});

module.exports = router;
