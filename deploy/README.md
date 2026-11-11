# 운영 배포 절차

입찰 레이더를 Cloud Run 에 올리는 실제 순서입니다. 이 폴더의 파일에는 실제 프로젝트 ID·주소·키가 없고 `<PROJECT_ID>`·`<PROJECT_NUMBER>`·`<project-ref>` 같은 자리표시만 있습니다. 실제 값은 저장소 밖 `.env.production`(git 제외)에만 둡니다.

구성: Cloud Run 서비스 1개(서울, 최소 0·최대 1 인스턴스, 512Mi, 요청 처리 중에만 CPU — 요청이 없으면 인스턴스가 0 으로 줄어 유휴 비용이 거의 없음, 주소는 Cloud Run 이 주는 `…run.app` 그대로) + Supabase 운영 프로젝트 + Secret Manager 비밀 10개 + GitHub Actions(WIF) 자동 배포. **예약 실행·도메인 매핑·부하분산기·상주 워커는 없습니다.**

- 공고 수집: 한국 시간으로 날짜가 바뀐 뒤 **첫 방문** 요청이 앱 자신의 잡 주소(`GET /api/jobs/collect?all=1`, 헤더 `x-job-token`)를 불러 수집을 시작합니다 (`APP_SCHEDULER_OFF=1`). 수집은 그 잡 요청 안에서 `APP_DAY_START_MAX_MS` 까지 돌고 남은 회사는 다음 방문이 이어 갑니다. 진행 상황은 `/status` 의 `오늘 수집` 줄에 보입니다. 이 기능 때문에 `APP_BASE_URL` 이 실제 서비스 주소와 같아야 합니다.
- 데모 초기화: 그날 첫 `데모로 둘러보기` 로그인이 초기화(`GET /api/jobs/demo-reset`)를 시작합니다.
- 매일 알림 메일·리마인더·지원사업 갱신·자동 결제는 **꺼져 있습니다** (화면에 `?` 안내). 결제는 토스 **테스트 키**로만 받습니다.

| 파일 | 하는 일 |
|---|---|
| `deploy/env.production.example` | 운영 환경변수 전체 목록. SECRET(비밀 10개)·ENV(평문)·DEPLOY(배포 입력)·UNUSED(운영에서 비움) 구역. 복사해 `.env.production` 을 만듭니다 |
| `deploy/gcp/setup.sh` | API·Artifact Registry·런타임/배포 서비스 계정·WIF·비밀 10개 만들기 (여러 번 돌려도 됨, `--dry-run`) |
| `deploy/gcp/apply-env.sh` | `.env.production` 을 읽어 마이그레이션·`app_worker`·비밀 10개·평문 env 를 반영하고 서비스를 공개 (`--skip-db`·`--dry-run`) |
| `deploy/gcp/service.yaml` | Cloud Run 서비스 매니페스트의 원본 (공개해도 되는 고정 값만). `apply-env.sh` 가 임시 파일로 채워 씁니다 |
| `.github/workflows/deploy.yml` | main 에 push 되고 `ci` 가 성공하면 이미지를 빌드해 **이미지만** 교체 |
| `deploy/supabase/PRODUCTION.md` | Supabase 운영 DB 세부 절차 (세션 풀러·Auth·백업·롤백) |
| `scripts/check-deploy.mjs` | 위 파일들이 서로 맞는지, 스케일 설정·`APP_SCHEDULER_OFF=1`·`APP_WORKER=0` 검사: `node scripts/check-deploy.mjs --example` → `DEPLOY_CONFIG_OK` (`--env .env.production` 으로 실제 파일도 검사) |

준비물: `gcloud`(`gcloud auth login`), Docker, Supabase CLI, `psql`, `openssl`, `python3`, GitHub 저장소 관리자 권한, 결제 계정이 연결된 GCP 프로젝트, **이미 만든 Supabase 운영 프로젝트**.

> 외부에서 살아 있는지 볼 때는 `/readyz` 를 씁니다. Cloud Run 프론트가 외부의 `/healthz` 요청을 가로채 앱까지 오지 않습니다. 컨테이너 안 시작 확인(`startupProbe`)은 `/healthz` 그대로입니다.

---

## 1. GCP 준비: 배포 서비스 계정·WIF (`setup.sh`)

```sh
export GCP_PROJECT_ID=<PROJECT_ID> GCP_REGION=asia-northeast3 ARTIFACT_REPO=bid-radar GITHUB_REPO=<owner>/<repo>
bash deploy/gcp/setup.sh --dry-run   # 실행할 명령만 확인
bash deploy/gcp/setup.sh
```

API 켜기 → Artifact Registry `bid-radar` → 런타임 SA `bid-radar-run`(비밀 읽기) → 배포 SA `bid-radar-deploy`(`run.admin`·`artifactregistry.writer`·런타임 SA 사용) → WIF 풀 `github-pool`/프로바이더 `github-provider`(`GITHUB_REPO` 저장소만 허용) → 비밀 10개 순서입니다. 비밀 값 입력은 건너뛰어도 됩니다 (4단계 `apply-env.sh` 가 넣습니다). 마지막에 출력되는 `GCP_WIF_PROVIDER`·`GCP_DEPLOY_SA` 는 5단계에서 씁니다.

## 2. `.env.production` 채우기

```sh
cp deploy/env.production.example .env.production   # git 에 올라가지 않음 (.env*)
```

`apply-env.sh` 가 읽는 값입니다. 표에 없는 ENV 구역 값도 채워 두면 Cloud Run 평문 env 로 들어갑니다(비우면 `service.yaml` 의 기본값).

| 변수 | 필수 | 어디서 | 들어가는 곳 |
|---|---|---|---|
| `GCP_PROJECT_ID` | 예 | GCP 콘솔 | 스크립트 |
| `GCP_REGION` | | 비우면 `asia-northeast3` | 스크립트 |
| `SUPABASE_URL` | 예 | `https://<project-ref>.supabase.co` | 평문 env |
| `SUPABASE_ANON_KEY` | 예 | Supabase → API Keys | 평문 env |
| `SUPABASE_SERVICE_ROLE_KEY` | 예 | Supabase → API Keys | Secret Manager |
| `SUPABASE_POOLER_URL` | 예 (`--skip-db` 면 아니오) | Supabase → Connect → **Session pooler** (`postgres.<project-ref>@…pooler.supabase.com:5432`, `[YOUR-PASSWORD]` 를 DB 비밀번호로) | 마이그레이션·`app_worker` 비밀번호 설정 (저장하지 않음) |
| `NARA_API_KEY` | 예 | 공공데이터포털 일반 인증키(Decoding) | Secret Manager |
| `TOSS_CLIENT_KEY` / `TOSS_SECRET_KEY` | | 토스 개발자센터 테스트 키 `test_ck_…` / `test_sk_…` | 평문 env / Secret Manager |
| `LLM_API_BASE`·`LLM_MODEL` / `LLM_API_KEY` | | OpenAI 호환 LLM 제공자 | 평문 env / Secret Manager |
| `SUPPORT_API_BASE` / `SUPPORT_API_KEY` | | 기업마당 API | 평문 env / Secret Manager |
| `EMAIL_FROM` / `EMAIL_API_KEY` | | Resend (인증한 메일 도메인이 있을 때만) | 평문 env / Secret Manager |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | | Cloudflare Turnstile (둘 다 있어야 가입 봇 확인이 켜짐) | 평문 env / Secret Manager |
| `APP_PLATFORM_ADMIN_EMAILS` | | `/admin` 을 볼 이메일 | 평문 env |
| `BUSINESS_*`·`PRIVACY_OFFICER` | | 사업자 정보 (비우면 화면에 "미설정") | 평문 env |
| `APP_BASE_URL` | | 비우면 `https://bid-radar-lite-<PROJECT_NUMBER>.<리전>.run.app` | 평문 env |

- **DB 연결은 Session pooler(5432)만 됩니다.** Connect 화면의 Direct 주소 `db.<project-ref>.supabase.co:5432` 는 IPv6 전용이라 Cloud Run 에서 붙지 않고, 트랜잭션 풀러(6543)는 쓰지 않습니다. `apply-env.sh` 는 `SUPABASE_POOLER_URL` 의 호스트로 `app_worker` 전용 `APP_DB_URL` 을 만듭니다.
- 비어 있는 선택 비밀(TOSS·LLM·SUPPORT·EMAIL·TURNSTILE)은 값이 아직 없을 때만 `unused` 로 만들어 둡니다 (Cloud Run 은 없는 비밀을 참조하면 배포에 실패). `*_API_BASE` 를 비워 두면 그 기능은 "준비 안 됨"으로 표시됩니다.
- Supabase Auth → Sign In / Providers 에서 **Confirm email 을 끄는 것**을 권장합니다. 메일 도메인(Resend) 없이 Supabase 기본 메일을 쓰면 발송 한도가 낮아 가입 확인 메일이 늦거나 오지 않습니다. 메일 확인을 켜려면 `deploy/supabase/PRODUCTION.md` 5단계대로 커스텀 SMTP 를 맞춥니다.
- 검사: `node scripts/check-deploy.mjs --env .env.production`

## 3. 첫 이미지 빌드·push (로컬 Docker)

서비스가 아직 없으므로 첫 이미지는 로컬에서 올립니다. Cloud Run 은 `linux/amd64` 이미지만 돌리므로 Apple Silicon 에서도 플랫폼을 지정합니다.

```sh
gcloud auth configure-docker asia-northeast3-docker.pkg.dev
TAG=$(git rev-parse --short HEAD)
IMAGE=asia-northeast3-docker.pkg.dev/<PROJECT_ID>/bid-radar/bid-radar-lite:$TAG
docker build --platform linux/amd64 -t "$IMAGE" .
docker push "$IMAGE"
```

태그는 커밋 해시로 둡니다. 자동 배포가 이 태그를 보고 이미지에 들어가는 파일이 바뀌었는지 판단합니다.

## 4. 첫 배포·공개 (`apply-env.sh`)

```sh
IMAGE="$IMAGE" bash deploy/gcp/apply-env.sh --dry-run   # 할 일만 출력 (외부 명령 실행 안 함)
IMAGE="$IMAGE" bash deploy/gcp/apply-env.sh
```

순서: Supabase 마이그레이션(`supabase db push`) → `app_worker` 새 비밀번호·`APP_DB_URL` → Secret Manager 비밀 10개(`APP_SECRET`·`APP_JOB_TOKEN` 은 버전이 없을 때만 무작위로 만들고, 나머지는 값이 바뀌었을 때만 새 버전) → `service.yaml` 을 임시 파일로 렌더(이미지·`<PROJECT_ID>`·`APP_BASE_URL`·`<project-ref>`·`.env.production` 의 평문 env) → `gcloud run services replace` → `allUsers` 에 `run.invoker`(공개) → `/readyz` 200 확인. 값은 화면에 출력하지 않고, 저장소 파일은 바꾸지 않습니다.

- 끝에 서비스 주소가 `APP_BASE_URL` 과 다르다는 안내가 나오면 `.env.production` 에 `APP_BASE_URL=<서비스 주소>` 를 적고 `bash deploy/gcp/apply-env.sh --skip-db` 를 한 번 더 돌립니다.
- Supabase Auth 의 Site URL·Redirect URLs 를 서비스 주소로 맞춥니다 (`deploy/supabase/PRODUCTION.md` 5단계).
- (선택) 토스 개발자센터 → 웹훅에 `<서비스 주소>/webhooks/toss` (이벤트 `PAYMENT_STATUS_CHANGED`).

## 5. GitHub Variables → 자동 배포

저장소 Settings → Secrets and variables → Actions → **Variables** 에 적습니다 (WIF 를 쓰므로 GCP 키 파일은 넣지 않습니다).

| Variable | 값 |
|---|---|
| `GCP_PROJECT_ID` | `<PROJECT_ID>` |
| `GCP_REGION` | `asia-northeast3` |
| `ARTIFACT_REPO` | `bid-radar` |
| `GCP_WIF_PROVIDER` | `projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github-pool/providers/github-provider` (setup.sh 출력) |
| `GCP_DEPLOY_SA` | `bid-radar-deploy@<PROJECT_ID>.iam.gserviceaccount.com` (setup.sh 출력) |

이후 main 에 push 하고 `ci` 워크플로가 성공하면 `deploy` 워크플로가 돌아갑니다.

- 커밋 해시 태그로 이미지를 빌드·push 하고 `deploy-cloudrun` 의 `service`+`image` 로 **이미지만** 바꿉니다. 평문 env·비밀·스케일 설정은 4단계에서 넣은 그대로 남습니다 (공개 저장소의 `service.yaml` 로 덮어쓰지 않으므로 `.env.production` 에서 온 값이 지워지지 않습니다).
- 지금 서비스 이미지의 태그(커밋)와 비교해 이미지에 들어가는 파일(`Dockerfile`·`.dockerignore`·`package*.json`·`app/`·`src/`·`config/`·`scripts/`)이 그대로면 배포를 건너뜁니다. 문서·테스트만 바뀐 커밋은 배포되지 않습니다.
- `ci` 가 실패하거나 취소되면 배포하지 않습니다. Actions 화면에서 수동 실행(workflow_dispatch)하면 변경 여부와 상관없이 배포합니다.
- 마지막에 `<서비스 주소>/readyz` 가 200 인지 확인합니다.

## 6. env·비밀 바꾸기 (`apply-env.sh --skip-db`)

`.env.production` 을 고친 뒤:

```sh
bash deploy/gcp/apply-env.sh --skip-db
```

마이그레이션과 `app_worker` 비밀번호는 건너뛰고 기존 `APP_DB_URL` 비밀을 그대로 씁니다. `IMAGE` 를 주지 않으면 지금 서비스가 쓰는 이미지를 그대로 씁니다. 새 마이그레이션이 생겼을 때는 `--skip-db` 없이 돌립니다 (`app_worker` 비밀번호도 새로 바뀝니다). `service.yaml` 의 고정 값(스케일·메모리·비용 상한 기본값)을 바꿨을 때도 이 명령으로 반영합니다.

## 7. 비용·확인

- 인스턴스 최소 0·최대 1, 요청 처리 중에만 CPU. 예약 실행·도메인 매핑·부하분산기가 없어 고정비가 없고, 무료 사용량 안에서는 월 비용이 거의 0 입니다. Secret Manager 활성 버전과 Artifact Registry 저장 용량은 무료 범위를 넘으면 소액이 붙으니 오래된 이미지는 가끔 지웁니다. 정확한 금액은 공식 요금표 확인.
- 결제 계정에 예산 알림을 겁니다 (아래 `예산 알림` 절).
- 확인:

```sh
gcloud run services describe bid-radar-lite --region=asia-northeast3 --project=<PROJECT_ID> --format='value(status.url)'
curl -s <서비스 주소>/readyz        # 200, db·인증 ok
curl -s <서비스 주소>/status.json   # 오늘 날짜(KST)
```

## 8. 스모크

| 확인 | 방법 | 기대 | 결과 |
|---|---|---|---|
| 연결 점검 | `curl -s <서비스 주소>/readyz` (외부에서 `/healthz` 는 쓰지 않음) | 200, db·큐·인증 ok | [ ] |
| 상태 페이지 | `curl -s <서비스 주소>/status.json` (브라우저는 `/status`) | 200, 오늘 날짜(KST) | [ ] |
| 첫 방문 수집 | 그날 처음으로 아무 화면(`/welcome`)을 열고 60초 안에 `/status.json` 다시 보기 | `collect.trigger` `first-visit`, `collect.state` `done` (`/status` 의 `오늘 수집` 이 `완료`) | [ ] |
| 데모 로그인 | 첫 화면 `데모로 둘러보기` 누르기 | 가입·메일 확인 없이 오늘의 공고 화면, 상단 데모 배너(`매일 첫 방문 때 초기화`) | [ ] |
| 가입 | 새 주소로 가입 | `입찰 레이더 가입 확인` 메일 수신 후 로그인 | [ ] |
| 무료 가져오기 | 가입한 회사의 오늘의 공고 화면 | `공고 가져오기` 버튼 옆 `무료 가져오기 5회 남음` | [ ] |
| 결제(테스트) | 요금제 화면에서 테스트 카드 등록 | 카드 요약 `****1234` 형식 표시 | [ ] |
| 예약 실행 안내 | 설정·지원사업·요금제 화면 | `?` 아이콘에 "비용 절감을 위해 예약 실행을 꺼 두었습니다" | [ ] |
| 푸터 | 아무 화면 아래 | 사업자 정보 표시 (`미설정` 없음) | [ ] |

## 비용 상한

공개 주소로 열어도 하루 비용이 위로 막히게 하는 장치입니다. 값은 전부 평문 env 입니다(`service.yaml` 기본값, `.env.production` 에 적으면 그 값). 바꾸면 `apply-env.sh --skip-db` 로 반영합니다.

| 장치 | 변수 | 기본값 | 넘으면 |
|---|---|---|---|
| 하루 알림 메일 수 (KST 자정 기준) | `APP_DAILY_MAX_EMAIL` | 200 | 그날 남은 메일은 보내지 않음 |
| 하루 LLM 호출 수 | `APP_DAILY_MAX_LLM` | 200 | 요약·키워드·자격 판정이 "준비 안 됨" |
| 하루 가입 수 | `APP_DAILY_MAX_SIGNUP` | 50 | 가입 화면이 내일 다시 오라고 안내 (429) |
| 하루 데모 로그인 수 | `APP_DAILY_MAX_DEMO_LOGIN` | 500 | 데모 버튼이 내일 다시 오라고 안내 (429) |
| 속도 규칙 배수 (IP·회사별 횟수 제한 전체에 곱함) | `APP_RATE_SCALE` | 1 | 429 + `Retry-After` |
| 요청 본문 상한 | `APP_BODY_LIMIT_BYTES` | 262144 (256KiB) | 413 |
| 요청 처리 상한 (잡·웹훅 제외) | `APP_REQUEST_TIMEOUT_MS` | 30000 | 504 |
| 만들 수 있는 회사 수 | `APP_MAX_WORKSPACES` | 50 | 회사 만들기 거절 |
| 예약 실행 없음 (첫 방문 수집·데모 초기화, 알림·자동 결제 꺼짐) | `APP_SCHEDULER_OFF` | 1 | (상한 아님) `1` 이 아니면 검사기가 배포를 막음 |
| 회사별 무료 `공고 가져오기` 횟수 (유료 구독은 무제한) | `APP_FREE_COLLECTS` | 5 | 버튼 비활성 + `요금제 보기` |
| 첫 방문 수집 요청 하나의 최대 시간(ms) | `APP_DAY_START_MAX_MS` | 240000 | 남은 회사는 다음 방문이 이어 감 |
| 첫 방문이 수집 시작을 기다리는 시간(ms) | `APP_DAY_START_KICK_WAIT_MS` | 1500 | 기다리지 않고 응답 (다음 방문이 다시 시도) |
| 수집 진행 중 표시 유효 시간(ms) | `APP_DAY_START_CLAIM_TTL_MS` | 600000 | 멈춘 수집을 다음 방문이 다시 시작 |
| 데모 로그인이 첫 초기화를 기다리는 시간(ms) | `APP_DAY_START_RESET_WAIT_MS` | 20000 | 기다리지 않고 로그인 진행 |

- 하루 예산 4개는 `0` 이면 무제한입니다. 데모 회사에서는 LLM 이 외부 호출 없이 거절됩니다.
- 인프라 쪽 상한: 인스턴스 최대 1 × 동시 요청 40, 요청이 없으면 인스턴스 0, 요청 처리 중에만 CPU. 예약 실행·도메인 매핑·부하분산기가 없어 고정비가 없고, 무료 사용량 안에서는 월 비용이 거의 0 이며, 넘더라도 인스턴스 1개 상한이 위를 막습니다.
- 가입 봇 확인은 `TURNSTILE_SITE_KEY`(평문)와 `TURNSTILE_SECRET_KEY`(비밀)가 둘 다 있을 때만 켜집니다.

## 예산 알림

코드 상한과 별개로 결제 계정에 예산 알림을 겁니다 (관리형·무료). 금액과 결제 계정 ID 는 이 파일에 적지 않습니다.

```sh
gcloud billing budgets create --billing-account=<BILLING_ACCOUNT_ID> \
  --display-name="bid-radar-lite monthly" --budget-amount=<월 상한 금액>KRW \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 \
  --filter-projects=projects/<PROJECT_ID>
```

- [ ] 결제 콘솔 → 예산 및 알림에 위 예산이 보이고, 알림 받을 이메일(결제 관리자)이 맞다
- [ ] 알림이 오면 먼저 `/admin` 의 오늘 수집·요청 수와 위 `비용 상한` 표 값을 확인합니다

## 롤백

이전 리비전으로 트래픽을 돌립니다. 자세한 명령은 `deploy/supabase/PRODUCTION.md` 8단계.

```sh
gcloud run services update-traffic bid-radar-lite --to-revisions=<이전 리비전>=100 --region=asia-northeast3 --project=<PROJECT_ID>
```
