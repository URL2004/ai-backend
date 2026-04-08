// [설정] Firebase 초기화, CORS 허용 도메인, 요청 제한(Rate Limiter)을 관리하는 파일

const admin = require('firebase-admin');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// 렌더 환경변수에 파이어베이스 키를 넣었다면 이렇게 사용
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// CORS 설정
const allowedOrigins = [
  'https://gpkorea.ai.kr',
  'https://www.gpkorea.ai.kr',
  'http://localhost:3000',
  'http://127.0.0.1:5500'
];

const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('허용되지 않은 접근입니다.'));
    }
  }
});

// Rate Limiter
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const dailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 1000,
  message: { error: '일일 사용량을 초과했습니다. 내일 다시 시도해주세요.' },
});

module.exports = { admin, db, corsMiddleware, limiter, dailyLimiter };
