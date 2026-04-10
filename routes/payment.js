// [결제] 토스페이먼츠 결제 확인 + Firebase 크레딧 지급 처리

const express = require('express');
const { admin, db } = require('../config');

const router = express.Router();

router.post('/confirm-payment', async (req, res) => {
  const { paymentKey, orderId, amount, customerEmail, uid, idToken } = req.body;

  // 서버에서 금액 기준으로 크레딧 직접 계산
  const CREDIT_MAP = { 2900: 100, 8700: 330, 14500: 600, 29000: 1300, 58000: 2700 };
  const safeCredits = CREDIT_MAP[parseInt(amount)];
  if (!safeCredits) {
    return res.status(400).json({ error: "유효하지 않은 결제 금액입니다." });
  }

  // Firebase ID Token으로 uid 서버 검증
  let verifiedUid = uid;
  if (idToken) {
    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      verifiedUid = decodedToken.uid;
      if (uid && uid !== verifiedUid) {
        console.warn(`⚠️ UID 불일치: client=${uid}, token=${verifiedUid}`);
      }
    } catch (tokenErr) {
      console.warn('⚠️ ID token 검증 실패:', tokenErr.message);
    }
  }

  if (!verifiedUid || verifiedUid === "undefined") {
    return res.status(400).json({ error: "유저 UID 정보가 없습니다." });
  }

  const secretKey = process.env.TOSS_SECRET_KEY;
  const basicToken = Buffer.from(secretKey + ":").toString("base64");

  try {
    const response = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ paymentKey, orderId, amount })
    });

    const result = await response.json();

    if (response.ok) {
      // 단일 트랜잭션으로 orders + credits + creditHistory 원자적 처리
      const orderRef = db.collection('orders').doc(orderId);
      const userRef = db.collection('users').doc(verifiedUid);

      try {
        await db.runTransaction(async (transaction) => {
          // === 모든 READ 먼저 ===
          const orderSnap = await transaction.get(orderRef);
          if (orderSnap.exists) {
            throw new Error('이미 처리된 결제입니다.');
          }
          const userSnap = await transaction.get(userRef);
          const currentCredits = userSnap.exists ? (userSnap.data().credits || 0) : 0;
          const newCredits = currentCredits + safeCredits;

          // === 모든 WRITE 후 ===
          transaction.set(orderRef, {
            uid: verifiedUid, amount, safeCredits,
            paymentKey,
            status: 'paid',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });

          if (userSnap.exists) {
            transaction.update(userRef, {
              credits: newCredits,
              lastPayment: admin.firestore.FieldValue.serverTimestamp()
            });
          } else {
            transaction.set(userRef, {
              credits: newCredits,
              lastPayment: admin.firestore.FieldValue.serverTimestamp()
            });
          }

          const historyRef = db.collection('users').doc(verifiedUid)
            .collection('creditHistory').doc();
          transaction.set(historyRef, {
            type: 'charge', used: 0, amount: safeCredits,
            remaining: newCredits, plan: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });

        console.log(`✅ 성공: ${customerEmail}(${verifiedUid})님께 ${safeCredits}크레딧 지급 완료!`);
        res.json({ ok: true, message: "충전 성공", creditAmount: safeCredits });
      } catch (e) {
        if (e.message === '이미 처리된 결제입니다.') {
          console.log(`⚠️ 중복 요청 차단: ${orderId}`);
          return res.status(400).json({ error: "이미 처리된 결제입니다." });
        }
        throw e;
      }
    } else {
      res.status(response.status).json(result);
    }
  } catch (err) {
    console.error("❌ 서버 에러:", err);
    res.status(500).json({ error: '서버 에러 발생' });
  }
});

// --- 환불 시스템 ---

// 관리자 UID 목록 (프론트엔드 ADMIN_ROLES와 동일하게 유지)
const ADMIN_UIDS = ['nC90IyjgaIZ8Z0JTABMTiyQHF9g1', 'qa0iQAeVmMOxoy6Vg5ENTRKk0Vm2', 'upyxtXMQEgQXfqTUWPrf6QS9EqE2'];

// Firebase ID Token 검증 헬퍼
async function verifyToken(idToken) {
  if (!idToken) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded.uid;
  } catch (e) {
    return null;
  }
}

// 환불 요청 (사용자용)
router.post('/request-refund', async (req, res) => {
  const { orderId, idToken, cancelReason } = req.body;

  const uid = await verifyToken(idToken);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (!orderId) return res.status(400).json({ error: '주문번호가 없습니다.' });
  if (!cancelReason || cancelReason.trim().length < 2) {
    return res.status(400).json({ error: '환불 사유를 입력해주세요.' });
  }

  try {
    const orderRef = db.collection('orders').doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });

    const order = orderSnap.data();
    if (order.uid !== uid) return res.status(403).json({ error: '본인의 주문만 환불 요청할 수 있습니다.' });
    if (order.status === 'refund_requested') return res.status(400).json({ error: '이미 환불 요청 중입니다.' });
    if (order.status === 'refunded') return res.status(400).json({ error: '이미 환불 완료된 주문입니다.' });
    if (order.status !== 'paid') return res.status(400).json({ error: '환불할 수 없는 주문 상태입니다.' });

    await orderRef.update({
      status: 'refund_requested',
      cancelReason: cancelReason.trim(),
      refundRequestedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`📋 환불 요청: ${orderId} (사유: ${cancelReason.trim()})`);
    res.json({ ok: true, message: '환불 요청이 접수되었습니다.' });
  } catch (err) {
    console.error('❌ 환불 요청 에러:', err);
    res.status(500).json({ error: '서버 에러 발생' });
  }
});

// 환불 승인 (관리자용)
router.post('/approve-refund', async (req, res) => {
  const { orderId, idToken } = req.body;

  const adminUid = await verifyToken(idToken);
  if (!adminUid) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (!ADMIN_UIDS.includes(adminUid)) return res.status(403).json({ error: '관리자 권한이 없습니다.' });
  if (!orderId) return res.status(400).json({ error: '주문번호가 없습니다.' });

  try {
    const orderRef = db.collection('orders').doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });

    const order = orderSnap.data();
    if (order.status !== 'refund_requested') {
      return res.status(400).json({ error: '환불 요청 상태가 아닙니다. 현재: ' + order.status });
    }
    if (!order.paymentKey) {
      return res.status(400).json({ error: 'paymentKey가 없어 환불할 수 없습니다. (이전 결제건)' });
    }

    // 토스페이먼츠 결제 취소 API 호출
    const secretKey = process.env.TOSS_SECRET_KEY;
    const basicToken = Buffer.from(secretKey + ':').toString('base64');

    const tossRes = await fetch(`https://api.tosspayments.com/v1/payments/${order.paymentKey}/cancel`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ cancelReason: order.cancelReason || '고객 요청 환불' })
    });

    const tossResult = await tossRes.json();

    if (!tossRes.ok) {
      console.error('❌ 토스 환불 실패:', tossResult);
      return res.status(tossRes.status).json({
        error: '토스 환불 처리 실패: ' + (tossResult.message || '알 수 없는 오류')
      });
    }

    // 토스 환불 성공 → Firestore 트랜잭션으로 크레딧 차감 + 상태 변경
    const userRef = db.collection('users').doc(order.uid);

    await db.runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef);
      const currentCredits = userSnap.exists ? (userSnap.data().credits || 0) : 0;
      const newCredits = Math.max(0, currentCredits - order.safeCredits);

      transaction.update(orderRef, {
        status: 'refunded',
        refundedAt: admin.firestore.FieldValue.serverTimestamp(),
        refundedBy: adminUid
      });

      transaction.update(userRef, {
        credits: newCredits
      });

      const historyRef = db.collection('users').doc(order.uid)
        .collection('creditHistory').doc();
      transaction.set(historyRef, {
        type: 'refund',
        used: 0,
        amount: -order.safeCredits,
        remaining: newCredits,
        orderId: orderId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    console.log(`✅ 환불 완료: ${orderId} (${order.safeCredits}크레딧 차감, 관리자: ${adminUid})`);
    res.json({ ok: true, message: '환불이 완료되었습니다.' });
  } catch (err) {
    console.error('❌ 환불 승인 에러:', err);
    res.status(500).json({ error: '서버 에러 발생' });
  }
});

// --- 친구 추천 ---
router.post('/apply-referral', async (req, res) => {
  try {
    const { idToken, refCode } = req.body;
    if (!idToken || !refCode) return res.status(400).json({ error: '필수 값 누락' });

    // 1. 신규 유저 인증 확인
    const decoded = await admin.auth().verifyIdToken(idToken);
    const newUid = decoded.uid;

    // 2. 자기 자신 추천 방지
    const newUserSnap = await db.collection('users').doc(newUid).get();
    if (!newUserSnap.exists) return res.status(400).json({ error: '유저 없음' });
    if (newUserSnap.data().refCode === refCode) return res.status(400).json({ error: '본인 추천 불가' });

    // 3. 이미 추천 받은 유저인지 확인
    if (newUserSnap.data().referredBy) return res.status(400).json({ error: '이미 추천 적용됨' });

    // 4. 추천인 찾기
    const referrerSnap = await db.collection('users').where('refCode', '==', refCode).limit(1).get();
    if (referrerSnap.empty) return res.status(400).json({ error: '유효하지 않은 추천 코드' });
    const referrerDoc = referrerSnap.docs[0];
    const referrerUid = referrerDoc.id;

    // 5. 양쪽에 50크레딧 지급 (트랜잭션)
    await db.runTransaction(async (t) => {
      t.update(db.collection('users').doc(newUid), {
        credits: admin.firestore.FieldValue.increment(20),
        referredBy: refCode
      });
      t.update(db.collection('users').doc(referrerUid), {
        credits: admin.firestore.FieldValue.increment(20)
      });
    });

    // 6. 크레딧 히스토리 기록
    const now = admin.firestore.FieldValue.serverTimestamp();
    const newUserCredits = (newUserSnap.data().credits || 0) + 20;
    const referrerCredits = (referrerDoc.data().credits || 0) + 20;

    await db.collection('users').doc(newUid).collection('creditHistory').add({
      type: 'referral', used: 0, amount: 20, remaining: newUserCredits,
      detail: '친구 추천 보상 (가입)', createdAt: now
    });
    await db.collection('users').doc(referrerUid).collection('creditHistory').add({
      type: 'referral', used: 0, amount: 20, remaining: referrerCredits,
      detail: '친구 추천 보상 (초대)', createdAt: now
    });

    console.log(`🎉 추천 완료: ${referrerUid} → ${newUid} (각 20크레딧)`);
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ 추천 에러:', err);
    res.status(500).json({ error: '추천 처리 실패' });
  }
});

module.exports = router;
