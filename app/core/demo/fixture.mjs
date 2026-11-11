// 예시 회사 데이터. 값은 전부 가상이다: 기관·회사 이름은 '(예시)' 접미, 사람 이름 대신 역할 이름, 주소는 example.com.
// 날짜는 오늘 기준 며칠 차이(postedOffset·deadlineOffset·dateOffset)로 적는다. 아래 postedAt·deadline·date 는
// 모듈을 읽은 날 기준 값이고, 초기화(seed.mjs)는 그때의 오늘로 다시 계산한다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Date → 오늘(KST)에서 offset 일 뒤의 'YYYY-MM-DD' */
export function kstDay(date, offset = 0) {
  return new Date(new Date(date).getTime() + KST_OFFSET_MS + offset * DAY_MS).toISOString().slice(0, 10);
}

const LOADED = new Date();

export const DEMO_COMPANY = { name: '새봄조경(예시)', ownerName: '예시 대표', staff: ['예시 구성원 가', '예시 구성원 나'] };

export const DEMO_CRITERIA = {
  keywords: ['조경', '수목', '공원'],
  excludeKeywords: ['철거'],
  regions: ['경기'],
  budgetMin: 0,
  budgetMax: 500000000,
  maxItems: 10,
};

// [번호, 공고명, 기관, 지역, 게시(오늘-), 마감(오늘+), 예산, 예산 기준, 종류]
const BID_ROWS = [
  [1, '가람시 중앙공원 조경 정비공사', '가람시 공원녹지과(예시)', '경기도', -1, 6, 238000000, 'estimated', 'new'],
  [2, '누리천 산책로 수목 식재공사', '누리군 환경과(예시)', '경기도', -2, 2, 96000000, 'base', 'new'],
  [3, '해솔근린공원 놀이시설 개선 및 조경공사', '해솔시 도시공원과(예시)', '경기도', -1, 9, 412000000, 'estimated', 'new'],
  [4, '다온초등학교 학교숲 조성 조경공사', '다온교육지원청(예시)', '경기도', 0, 12, 154000000, 'assigned', 'new'],
  [5, '가람시 가로수 수목 보식 및 생육관리', '가람시 녹지관리과(예시)', '경기도', -3, 4, 67000000, 'estimated', 'rebid'],
  [6, '누리체육공원 잔디 및 수목 유지관리 용역', '누리군 체육시설사업소(예시)', '경기도', -2, 8, null, null, 'new'],
  [7, '하늘마을 소공원 조성공사', '해솔시 도시재생과(예시)', '경기도', -4, 3, 188000000, 'base', 'changed'],
  [8, '도심 녹지축 조경 설계 변경 공사', '다온구 공원과(예시)', '서울특별시', -1, 10, 320000000, 'estimated', 'new'],
  [9, '노후 정자 철거 및 공원 정비공사', '가람시 공원녹지과(예시)', '경기도', -2, 7, 58000000, 'estimated', 'new'],
  [10, '수변공원 경관 조명 설치공사', '누리군 하천과(예시)', '경기도', -3, 5, 730000000, 'estimated', 'new'],
  [11, '한빛공원 화단 조경 개선공사', '한빛시 공원관리과(예시)', '경기도', -5, -1, 84000000, 'base', 'new'],
  [12, '솔내 생태숲 수목 식재 2차 공사', '솔내군 산림과(예시)', '경기도', -5, -2, 126000000, 'estimated', 'new'],
  [13, '청사 주차장 포장 보수공사', '해솔시 회계과(예시)', '경기도', -1, 11, 45000000, 'estimated', 'new'],
  [14, '마을 쉼터 조경 및 벤치 설치공사', '누리군 마을사업과(예시)', '경기도', 0, 13, 72000000, 'assigned', 'new'],
];

const pad3 = (n) => String(n).padStart(3, '0');

export const DEMO_BIDS = BID_ROWS.map(([n, title, org, region, postedOffset, deadlineOffset, budget, budgetBasis, kind]) => ({
  bidId: `DEMO-${pad3(n)}`,
  title,
  org,
  region,
  deadline: `${kstDay(LOADED, deadlineOffset)} 10:00`,
  budget,
  budgetBasis,
  kind,
  url: `https://example.com/demo/DEMO-${pad3(n)}`,
  source: 'demo',
  postedAt: kstDay(LOADED, postedOffset),
  postedOffset,
  deadlineOffset,
}));

const inRange = (amount, basis) => `예산 범위 안 (${basis} ${amount}, 부가세 별도)`;

export const DEMO_MATCHES = {
  matched: [
    { bidId: 'DEMO-001', reasons: ["키워드 '조경' 일치", "참가 가능 지역 '경기' 일치", inRange('2.38억 원', '추정가격')] },
    { bidId: 'DEMO-002', reasons: ["키워드 '수목' 일치", "참가 가능 지역 '경기' 일치", '예산 범위 안 (기초금액 9,600만 원, 부가세 포함)'] },
    { bidId: 'DEMO-003', reasons: ["키워드 '조경' 일치", "키워드 '공원' 일치", "참가 가능 지역 '경기' 일치", inRange('4.12억 원', '추정가격')] },
    { bidId: 'DEMO-004', reasons: ["키워드 '조경' 일치", "참가 가능 지역 '경기' 일치", '예산 범위 안 (배정예산 1.54억 원, 부가세 포함)'] },
    { bidId: 'DEMO-005', reasons: ["키워드 '수목' 일치", "참가 가능 지역 '경기' 일치", inRange('6,700만 원', '추정가격')] },
    { bidId: 'DEMO-006', reasons: ["키워드 '공원' 일치", "키워드 '수목' 일치", "참가 가능 지역 '경기' 일치", '예산 정보 없음'] },
    { bidId: 'DEMO-007', reasons: ["키워드 '공원' 일치", "참가 가능 지역 '경기' 일치", '예산 범위 안 (기초금액 1.88억 원, 부가세 포함)'] },
  ],
  maybe: { bidId: 'DEMO-014', reasons: ["비슷한 말 '쉼터' 일치 (키워드 '공원')", "참가 가능 지역 '경기' 일치"] },
};

export const DEMO_INTERESTS = [
  { bidId: 'DEMO-002', note: '현장 설명회 참석 여부 확인' },
  { bidId: 'DEMO-001', note: '작년 비슷한 공사 실적 정리해 두기' },
  { bidId: 'DEMO-003', note: '놀이시설 협력사 견적 받기' },
  { bidId: 'DEMO-007', note: null },
];

export const DEMO_ASSIGNMENTS = [
  { bidId: 'DEMO-001', assignee: 'owner', status: 'go' },
  { bidId: 'DEMO-002', assignee: 'staffA', status: 'review' },
  { bidId: 'DEMO-003', assignee: 'staffB', status: 'review' },
  { bidId: 'DEMO-005', assignee: 'staffA', status: 'pass' },
  { bidId: 'DEMO-007', assignee: 'staffB', status: 'go' },
];

// 낙찰 이력: 지난 개찰 결과(사실만). result 는 예시 회사 기준 won(낙찰)·lost(다른 업체 낙찰)
const HISTORY_ROWS = [
  [null, '가람시 시민공원 조경 보수공사', '가람시 공원녹지과(예시)', 'won', 182400000, -6],
  [null, '누리군 하천변 수목 식재공사', '누리군 환경과(예시)', 'lost', 94300000, -11],
  [null, '해솔시 어린이공원 리모델링 조경공사', '해솔시 도시공원과(예시)', 'won', 265700000, -17],
  [null, '다온구 가로수 정비 수목공사', '다온구 공원과(예시)', 'lost', 71800000, -23],
  [null, '한빛시 근린공원 산책로 조경공사', '한빛시 공원관리과(예시)', 'won', 138900000, -38],
  [null, '솔내군 휴양림 진입로 조경공사', '솔내군 산림과(예시)', 'lost', 203500000, -52],
  [null, '가람시 학교 앞 녹지 조성공사', '가람시 녹지관리과(예시)', 'lost', 58200000, -71],
];

export const DEMO_HISTORY = HISTORY_ROWS.map(([bidId, title, org, result, amount, dateOffset]) => ({
  bidId,
  title,
  org,
  result,
  amount,
  date: kstDay(LOADED, dateOffset),
  dateOffset,
}));

const TEXT_1 = [
  '1. 사업명: 가람시 중앙공원 조경 정비공사',
  '2. 사업 내용: 중앙공원 산책로 주변 노후 수목 교체 및 초화류 식재, 휴게 공간 포장 정비',
  '3. 입찰 참가 자격: 조경식재공사업 또는 조경시설물설치공사업 등록 업체로서 경기도에 주된 영업소를 둔 자',
  '4. 제출 서류: 입찰참가신청서, 사업자등록증 사본, 건설업 등록증 사본, 인감증명서',
  '5. 공사 기간: 착공일로부터 120일',
].join('\n');

const TEXT_2 = [
  '1. 사업명: 누리천 산책로 수목 식재공사',
  '2. 사업 내용: 누리천 산책로 약 1.2km 구간에 느티나무와 왕벚나무 식재 및 지주목 설치',
  '3. 입찰 참가 자격: 조경식재공사업 등록 업체이며 중소기업기본법에 따른 소기업 또는 소상공인',
  '4. 제출 서류: 입찰참가신청서, 조경식재공사업 등록증 사본, 소기업 확인서',
  '5. 현장 설명: 별도 현장 설명회 없음',
].join('\n');

export const DEMO_SUMMARIES = [
  {
    bidId: 'DEMO-001',
    text: TEXT_1,
    summary: '중앙공원 산책로 주변 노후 수목을 바꾸고 초화류를 심으며 휴게 공간 포장을 정비하는 공사입니다.',
    qualification: '조경식재 또는 조경시설물설치 공사업 등록 업체로 경기도에 주된 영업소가 있어야 합니다.',
    documents: '입찰참가신청서, 사업자등록증·건설업 등록증 사본, 인감증명서를 냅니다.',
    evidence: [
      { field: 'what', quote: '중앙공원 산책로 주변 노후 수목 교체 및 초화류 식재' },
      { field: 'qualification', quote: '경기도에 주된 영업소를 둔 자' },
      { field: 'documents', quote: '입찰참가신청서, 사업자등록증 사본, 건설업 등록증 사본, 인감증명서' },
    ],
  },
  {
    bidId: 'DEMO-002',
    text: TEXT_2,
    summary: '누리천 산책로 약 1.2km 구간에 느티나무와 왕벚나무를 심고 지주목을 세우는 공사입니다.',
    qualification: '조경식재공사업 등록 업체이면서 소기업 또는 소상공인이어야 합니다.',
    documents: '입찰참가신청서, 조경식재공사업 등록증 사본, 소기업 확인서를 냅니다.',
    evidence: [
      { field: 'what', quote: '느티나무와 왕벚나무 식재 및 지주목 설치' },
      { field: 'qualification', quote: '소기업 또는 소상공인' },
      { field: 'documents', quote: '입찰참가신청서, 조경식재공사업 등록증 사본, 소기업 확인서' },
    ],
  },
];

export const DEMO_TEXT = {
  banner: '예시 데이터로 둘러보는 중입니다 · 매일 04:00 초기화 · 결제 화면은 테스트 모드라 실제 결제가 일어나지 않습니다',
  bannerOff: '예시 데이터로 둘러보는 중입니다 · 매일 첫 방문 때 초기화 · 결제 화면은 테스트 모드라 실제 결제가 일어나지 않습니다',
  bannerLink: '내 회사로 시작하기',
  chip: '예시 데이터',
  blocked: '예시 회사에서는 이 동작을 막아 두었습니다. 내 회사를 만들면 쓸 수 있습니다.',
  button: '데모로 둘러보기',
  caption: '가입 없이 예시 회사로 바로 들어갑니다. 예시 데이터이며 매일 초기화됩니다.',
  closed: '오늘은 데모 이용이 많아 잠시 닫혀 있습니다. 내일 다시 열립니다.',
  preparing: '데모를 준비하는 중입니다. 잠시 뒤 다시 눌러 주세요.',
  accountLocked: '예시 계정은 바꾸거나 지울 수 없습니다',
};
