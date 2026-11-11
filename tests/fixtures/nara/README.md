# 나라장터 fixture

모든 레인이 같은 결정적 응답으로 개발·검증하도록 만든 응답 묶음이다. 레인은 읽기만 한다.

- 녹화: `npm run record:nara -- --out <dir>` (2026-11-02, 오퍼레이션당 1회, 총 10회 호출). 키는 `.env` 에서만 주입되고 출력·저장되지 않는다.
- 2차 녹화(2026-11-02): `npm run record:nara -- --only prestd-cnstwk,openg-result-cnstwk,scsbid-list-cnstwk --days 30 --rows 20 --out <dir>` (3회 호출). 옵션 `--days N`(1~90) `--rows N`(1~100) `--op <name>=<operation>`.
- **커밋된 JSON 은 모두 합성이다.** 실제 응답은 필드명·값 형식·구조만 확인하는 데 썼고, 값(공고번호·기관·금액·날짜)은 결정적 테스트를 위해 새로 만들었다.
  - `recorded` = 실제 응답에서 확인한 필드명·형식으로 합성. `handwritten` = 실제 응답을 받지 못해 공개 명세 기억으로 작성, 필드명 `미확인`.
- 공고번호는 실제 형식(`R26BK` + 8자리)을 따른 가짜 번호 `R26BK01900001`~`R26BK01900650`(재공고 `R26BK01900660`), 사전규격번호 `R26BD009xxxxx`.
- 낙찰자·투찰업체는 `업체A`~`업체E`, 사업자번호 `0000000000`, 대표자 `대표자`, 업체 주소·전화·공고 담당자 연락처는 빈 값, 담당자는 `담당자`. 녹화 스크립트의 `anonymizeItems` 가 같은 규칙으로 치환한다.
- 모든 파일 형태: `{"response":{"header":{"resultCode","resultMsg"},"body":{"items":[...],"numOfRows","pageNo","totalCount"}}}`.

## 파일

| 파일 | 오퍼레이션 | recorded/handwritten | 확인된 필드(면허명·지역·기초금액·SME·개찰일시·사전규격번호) | inqryDiv 의미 |
|---|---|---|---|---|
| `list-cnstwk-p1.json` | `BidPublicInfoService/getBidPblancListInfoCnstwk` | recorded (합성 500건, totalCount 650, numOfRows 500, pageNo 1) | 개찰일시 `opengDt`, 사전규격번호 `bfSpecRgstNo`, 추정가격 `presmptPrce`, 예산 `bdgtAmt`(= 추정가격 + `VAT`), 공사현장 `cnstrtsiteRgnNm`, 공고종류 `ntceKindNm`, SME `미확인` | 1 = 공고게시(등록)일시 |
| `list-cnstwk-p2.json` | 같음 | recorded (합성 150건, pageNo 2) | 같음 | 1 |
| `list-cnstwk-changed.json` | 같음 | recorded (합성 3건: `변경공고` 1·`취소공고` 1·`재공고` 1) | `chgDt`, `chgNtceRsn`, `ntceKindNm`, `reNtceYn` | 3 = 변경일시 |
| `license-limit.json` | `BidPublicInfoService/getBidPblancListInfoLicenseLimit` | recorded | 면허명 `lcnsLmtNm`(`이름/코드` 한 문자열), 그룹 `lmtGrpNo`, 순번 `lmtSno`, `permsnIndstrytyList`, `bsnsDivNm` | 1 = 등록일시 |
| `region-limit.json` | `BidPublicInfoService/getBidPblancListInfoPrtcptPsblRgn` | recorded | 지역 `prtcptPsblRgnNm`(시도 또는 `시도 시군구`), 순번 `lmtSno`, `bsnsDivNm` | 1 = 등록일시 |
| `base-amount.json` | `BidPublicInfoService/getBidPblancListInfoCnstwkBsisAmount` | recorded | 기초금액 `bssamt`, `bssamtOpenDt`, `rsrvtnPrceRngBgnRate`/`EndRate`, `bidNtceNm` | 1 = 등록일시 |
| `prestd-cnstwk.json` | `HrcspSsstndrdInfoService/getPublicPrcureThngInfoCnstwk` | recorded (합성 3건, 실측 필드 22개 전부) | 사전규격번호 `bfSpecRgstNo`, 품명 `prdctClsfcNoNm`, 의견마감 `opninRgstClseDt`(`yyyy-MM-dd HH:mm:ss`), 배정예산 `asignBdgtAmt`, `orderInsttNm`, `rlDminsttNm`, 본공고 번호 `bidNtceNoList`, `rgstDt`, `chgDt`, 담당자 `ofclNm`·`ofclTelNo` | 1 = 등록일시 |
| `openg-result-cnstwk.json` | `ScsbidInfoService/getOpengResultListInfoCnstwk` | recorded (합성 5건, 실측 필드 16개) | 개찰일시 `opengDt`, `prtcptCnum`, 1순위 `opengCorpInfo`(`상호^사업자번호^대표자^금액^투찰률`), `progrsDivCdNm`(`개찰완료`·`유찰` 등), `inptDt`, `rbidNo`(`000` 형식). 낙찰 필드 없음 | 1 = 등록일시 |
| `scsbid-list-cnstwk.json` | `ScsbidInfoService/getScsbidListSttusCnstwk` | recorded (합성 2건: 101·105 만 낙찰 확정) | 업체 `bidwinnrNm`, 사업자번호 `bidwinnrBizno`, 대표자 `bidwinnrCeoNm`, 금액 `sucsfbidAmt`, 율 `sucsfbidRate`, 실개찰일시 `rlOpengDt`, 최종낙찰일 `fnlSucsfDate`(`yyyy-MM-dd`), `rgstDt`, 주소 `bidwinnrAdrs`·전화 `bidwinnrTelNo`(빈 값으로 치환) | 1 = 등록일시 |
| `error-22.json` | 공통 (할당량 초과) | handwritten | resultCode `22` | — |
| `error-30.json` | 공통 (등록되지 않은 키) | handwritten | resultCode `30` | — |

## 확정 사항 (2026-11-02 실호출)

- **inqryDiv** (`getBidPblancListInfoCnstwk`): `1` = 공고게시일시 창(`inqryBgnDt`~`inqryEndDt`) → 정상. `2` + 날짜 창 → resultCode `08 필수값 입력 에러` (공고번호 조회로 추정, 날짜만으로는 안 됨). `3` + 날짜 창 → 정상, 돌려받은 건의 `chgDt` 가 창 안이고 `bidNtceDt` 는 창 밖 → **3 = 변경일시**. 수집 레인의 "변경일시 조회"는 `inqryDiv=3` 을 쓴다.
- **ntceKindNm 값**: 관측 `등록공고`, `변경공고`. `취소공고`·`재공고` 는 미관측(형식 추정). 정규화는 부분 일치(`includes('변경')` 등)로 판정할 것.
- **면허제한**: 별도 코드 필드 없음. `lcnsLmtNm` 이 `조경식재공사업/4993` 처럼 `이름/코드` 를 한 문자열로 준다 → `{name, code}` 는 마지막 `/` 로 나눈다. 같은 `lmtGrpNo` 안 여러 행·다른 그룹의 의미(AND/OR)는 `미확인`. 응답에 물품 공고(`bsnsDivNm: 물품`)도 섞여 온다. fixture 의 업종 코드는 합성값이다.
- **참가가능지역**: 목록 응답에 `prtcptLmtRgnNm` 필드는 **없다**. 지역 제한은 `getBidPblancListInfoPrtcptPsblRgn` 의 `prtcptPsblRgnNm` 행(공고당 여러 행, `lmtSno`)으로만 온다. 목록의 관련 필드는 `rgnLmtBidLocplcJdgmBssNm`(예: `본사또는참여지사소재지`), `cmmnSpldmdCorpRgnLmtYn`, `cnstrtsiteRgnNm`(공사현장, 참가 제한 아님). `tests/fixtures/nara-bids.json` 의 `prtcptLmtRgnNm` 은 기존 테스트 호환용 handwritten 필드다.
- **금액**: 공사 목록에는 `asignBdgtAmt` 필드가 **없다**. `presmptPrce`(추정가격, VAT 제외) + `VAT` = `bdgtAmt` 관측(18,000,000 + 1,800,000 = 19,800,000). 기초금액 `bssamt` 는 기초금액 오퍼레이션에만 있다.
- **SME(중소기업 제한) 필드명: `미확인`**. 공사 목록 응답 필드 전체(약 150개)에 중소기업 제한 플래그로 보이는 필드가 없다. 가까운 필드는 `bidPrtcptLmtYn`(입찰참가제한 여부)·`indstrytyLmtYn`(업종제한 여부)뿐이고 의미가 다르다. fixture 에는 SME 필드를 넣지 않았다 → `limits.sme` 는 `null`.
- **사전규격 서비스 주소**: `https://apis.data.go.kr/1230000/ao/HrcspSsstndrdInfoService` — `ad/` 경로는 resultCode `12`(서비스 없음). 2차 녹화에서 `getPublicPrcureThngInfoCnstwk` 가 code `00` 으로 응답(30일 창 total 219) → 오퍼레이션명·필드 확정.
- **개찰결과 서비스 주소**: `https://apis.data.go.kr/1230000/as/ScsbidInfoService` — `ad/` 경로는 `12`. 2차 녹화에서 `getOpengResultListInfoCnstwk` 가 code `00`(30일 창 total 9008) → 오퍼레이션명·필드 확정.
  - 설정의 `NARA_PRESTD_BASE`·`NARA_SCSBID_BASE` 기본값(`.../ad/...`)은 위 주소로 바꿔야 한다.
- **(a) 낙찰 목록**: 공사 낙찰 목록 오퍼레이션은 `ScsbidInfoService/getScsbidListSttusCnstwk`(code `00`, 30일 창 total 8392). 필드: 업체 `bidwinnrNm`, 사업자번호 `bidwinnrBizno`, 대표자 `bidwinnrCeoNm`, 금액 `sucsfbidAmt`, 율 `sucsfbidRate`, 실개찰일시 `rlOpengDt`, 최종낙찰일 `fnlSucsfDate`, 등록일시 `rgstDt`. 조인 키는 `bidNtceNo`+`bidNtceOrd`(개찰결과와 같은 형식). `inqryDiv=1` 은 등록일시(`rgstDt`) 창으로 보인다(최종낙찰일 이후 등록).
- **(b) `bidNtceNoList` 형식**: 쉼표(`,`) 구분, 공백 없음, 차수(`-000`) 미포함, 공고번호만. 여러 개일 수 있다. 예: `R26BK01900005,R26BK01900006`(가짜 번호로 치환). 30일 창 20건 중 7건이 값을 가졌다.
- **(c) 개찰결과에 낙찰 필드 없음**: `getOpengResultListInfoCnstwk` 응답에 `bidwinnrNm`·`sucsfbidAmt`·`sucsfbidRate` 가 없다. `opengCorpInfo` 는 개찰 1순위일 뿐이고 낙찰자와 다를 수 있다 → 낙찰자는 낙찰 목록에 있을 때만 확정으로 본다. 유찰 건은 `opengCorpInfo` 가 빈 값.
- **오류 형식**: 서비스 단 오류(예: `08`)는 위 JSON 형태의 header 로 온다. 게이트웨이 오류(`12`, `22`, `30` 등)는 실제로는 HTTP 4xx + `{"OpenAPI_ServiceResponse":{"cmmMsgHeader":{"returnReasonCode","returnAuthMsg","errMsg"}}}` 로 온다. `error-22/30.json` 은 계약 형태로 맞춘 handwritten 이다.
