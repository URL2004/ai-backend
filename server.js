// [메인] 서버 초기화, 미들웨어 설정, 라우트 연결을 담당하는 진입점

// 1. dotenv 설정을 최상단에 추가 (이게 있어야 .env 파일을 읽습니다)
require('dotenv').config();
const express = require('express');
const { corsMiddleware, limiter } = require('./config');

const app = express();
app.set('trust proxy', 1);

// 미들웨어
app.use(corsMiddleware);
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - IP: ${ip}`);
  next();
});

// Rate Limiter
app.use('/analyze', limiter);
app.use('/analyze-pdf', limiter);

// 라우트
app.use('/', require('./routes/analyze'));
app.use('/', require('./routes/kakaoLogin'));
app.use('/', require('./routes/payment'));
app.use('/', require('./routes/subscription'));
app.use('/', require('./routes/coupon'));

// ★ 긴 휴머나이즈 요청(서버측 청크 병렬 처리)이 Node 기본 requestTimeout(300s)에 죽지 않도록 상향.
//   응답을 끝까지 쥐고 한 번에 보내는 구조라, 처리시간이 길면 Node가 소켓을 강제 종료해 "결과 없이 차감" 민원이 됨.
//   requestTimeout만 풀면 headersTimeout(기본 60s)이 여전히 끊으므로 둘 다 설정. 0(비활성)은 소켓 영구점유 위험 → 큰 유한값.
const server = app.listen(process.env.PORT || 3000, () => console.log('서버 시작!'));
server.requestTimeout = 1_200_000;   // 20분
server.headersTimeout = 1_200_000;   // requestTimeout과 짝
server.keepAliveTimeout = 75_000;    // 프록시 keep-alive 정합
