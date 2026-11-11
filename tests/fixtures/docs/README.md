# 공고문 첨부 fixture (tests/fixtures/docs)

`tests/unit/core-bidtext.test.mjs` 가 읽는다. 바꾸면 그 테스트의 기대 문장도 함께 바꾼다.

| 파일 | 형식 | 만드는 법 / 출처 | 테스트가 확인하는 문장 |
|------|------|------------------|------------------------|
| `sample.hwpx` | HWPX (zip + OWPML XML) | `node tests/fixtures/docs/make-hwpx.mjs` 로 생성 (고정 mtime → 다시 돌려도 바이트 동일) | `조경식재공사업 등록업체`, 표 행 `추정가격<TAB>120,000,000원` |
| `sample.hwp` | HWP 5 (OLE 복합문서) | hwp.js 저장소 테스트 샘플을 그대로 복사 (아래 출처) | `리포트의 제목`, 표 셀 `과목명<TAB>…` |
| `corrupt.hwp` | 임의 바이트 512B | `make-hwpx.mjs` 가 고정 시드(20261102, mulberry32)로 생성 | 파싱 실패 → 그 첨부만 failed |

## sample.hwp 출처

- 원본: `packages/parser/src/__tests__/data/basicsReport.hwp`
- URL: https://github.com/hahnlee/hwp.js/blob/fc211a5809499e973dc44620e274b768bcd8c2f6/packages/parser/src/__tests__/data/basicsReport.hwp
- 저장소: https://github.com/hahnlee/hwp.js (커밋 `fc211a5809499e973dc44620e274b768bcd8c2f6`, 2021-09-04)
- 라이선스: Apache License 2.0 (https://github.com/hahnlee/hwp.js/blob/HEAD/LICENSE). 수정 없이 테스트 입력으로만 쓴다.
- 크기 344,576 바이트, SHA-1 `d1e7f6183c0fb174f7e90316c2b5a3c64aac33ef`
- 포함 문장: `리포트의 제목` (첫 문단), 표 `과목명` / `담당교수` / `학번` 행
