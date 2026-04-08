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

module.exports = router;
