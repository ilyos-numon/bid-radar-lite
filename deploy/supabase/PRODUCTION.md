# Supabase 운영 데이터베이스 절차

운영자가 위에서부터 차례로 따라 합니다. 실제 값(프로젝트 ref·비밀번호·키)은 이 파일에 적지 않습니다. 화면 위치·메뉴 이름은 Supabase 판마다 다를 수 있으니 막히면 공식 문서(https://supabase.com/docs)를 봅니다.

## 채울 값

| 항목 | 값 (적지 않음 — 비밀번호 관리자에 보관) |
|---|---|
| 프로젝트 ref (`<project-ref>`) | |
| 데이터베이스 비밀번호 (postgres) | |
| `app_worker` 비밀번호 | |
| 세션 풀러 주소 (→ `APP_DB_URL`) | |
| Project URL (→ `SUPABASE_URL`) | |
| anon 키 (→ `SUPABASE_ANON_KEY`) | |
| service_role 키 (→ `SUPABASE_SERVICE_ROLE_KEY`) | |
| 공개 도메인 (`<도메인>`) | |

## 1. 프로젝트 만들기

- [ ] Supabase 대시보드에서 새 프로젝트를 만듭니다. 리전은 **Northeast Asia (Seoul) `ap-northeast-2`**.
- [ ] 데이터베이스 비밀번호는 생성기로 길게 만들고 비밀번호 관리자에 보관합니다.
- [ ] 백업·PITR 을 쓰려면 Pro 이상 요금제가 필요합니다 (5단계).
- [ ] Project Settings → API 에서 Project URL·anon 키·service_role 키를 위 표대로 옮겨 적습니다.

## 2. 저장소와 연결

로컬에서 저장소 루트에 서서 실행합니다. Supabase CLI 가 필요합니다 (`npm run supabase:*` 와 같은 CLI).

```sh
supabase login
supabase link --project-ref <project-ref>
```

## 3. 마이그레이션 적용

`supabase/migrations/` 의 모든 파일을 순서대로 적용합니다 (이번 판 기준 6개: 플랫폼·테넌트 표·SaaS 플랫폼·결제·이메일·약관).

```sh
supabase db push --dry-run   # 적용될 파일 목록 확인
supabase db push
```

- [ ] `supabase migration list` 에서 Local 과 Remote 열이 모두 같은지 확인합니다.
- [ ] Vault·`pgmq` 확장이 켜졌는지 확인합니다 (마이그레이션이 켭니다). SQL Editor 에서:

```sql
select extname from pg_extension where extname in ('pgmq', 'supabase_vault');
```

`supabase/seed.sql` 은 로컬 전용입니다. 운영에는 적용하지 않습니다 (`db push` 는 seed 를 넣지 않습니다).

## 4. 앱 접속 계정 (`app_worker`)

- [ ] SQL Editor 에서 로컬과 **다른** 긴 비밀번호로 로그인을 켭니다.

```sql
alter role app_worker login password '<app_worker 비밀번호>';
```

- [ ] Connect → Connection string → **Session pooler (포트 5432)** 주소를 고르고 사용자를 `app_worker.<project-ref>` 로, 비밀번호를 위 값으로 바꿔 `APP_DB_URL` 로 씁니다.

```
postgresql://app_worker.<project-ref>:<app_worker 비밀번호>@<세션 풀러 호스트>:5432/postgres
```

- **직접 연결(`db.<project-ref>.supabase.co:5432`)은 쓰지 않습니다.** 이 주소는 IPv6 전용이라 Cloud Run(IPv4 외부 연결)에서 붙지 않습니다. 반드시 세션 풀러 주소를 씁니다.
- **트랜잭션 풀러(6543)는 쓰지 않습니다.** 앱은 연결 하나에 "지금 회사" 설정을 걸어 두고 쓰므로 트랜잭션 풀러에서는 화면이 비어 보입니다.
- [ ] 이 주소는 Secret Manager 비밀 `APP_DB_URL` 로만 넣습니다 (`deploy/gcp/setup.sh` 가 입력받음).
- [ ] 연결 확인: `psql "<APP_DB_URL>" -Atc "select current_user"` → `app_worker`.

## 5. Auth 설정

Authentication → URL Configuration / Emails / Rate Limits:

- [ ] Site URL: `https://<도메인>`
- [ ] Redirect URLs: `https://<도메인>/auth/callback` (로컬 `http://localhost:*` 항목은 넣지 않습니다)
- [ ] 가입 확인 메일 제목: `입찰 레이더 가입 확인` (로컬 `supabase/config.toml` 과 같게)
- [ ] 커스텀 SMTP 켜기 = Resend
  - Host `smtp.resend.com`, Port `465`, User `resend`, Password = Resend API 키 (`EMAIL_API_KEY` 와 같은 키 또는 SMTP 전용 키)
  - Sender = `EMAIL_FROM` 과 같은 인증된 도메인 주소
- [ ] 메일 발송 한도(Rate Limits → emails per hour)를 예상 가입 수에 맞춰 올립니다. 기본 SMTP 의 낮은 한도는 커스텀 SMTP 를 켜야 풀립니다.
- [ ] Email 확인(Confirm email)이 켜져 있는지 확인합니다.

## 6. 백업·PITR·복구 리허설

- [ ] Database → Backups: Pro 요금제의 **일일 백업(7일 보존)** 이 보이는지 확인합니다.
- [ ] PITR(Point in Time Recovery) 애드온을 켭니다. WAL 보존 **7일** 을 권장합니다 (비용은 애드온 요금표 확인).
- [ ] 복구 리허설 (출시 전 1회, 이후 분기마다):
  1. 별도 스테이징 프로젝트를 하나 만듭니다 (운영 프로젝트에 직접 복원하지 않습니다).
  2. 운영 프로젝트의 백업 또는 PITR 시점을 스테이징으로 복원합니다 (대시보드의 "Restore to new project" 류 기능, 없으면 `supabase db dump` → `psql` 로 스테이징에 넣기).
  3. 스테이징에서 `select count(*) from public.workspaces;` 등 주요 표 행 수를 운영과 비교합니다.
  4. 걸린 시간과 결과를 운영 기록에 남기고 스테이징 프로젝트를 지웁니다.

## 7. 모니터링

- [ ] Reports → Database 에서 연결 수를 봅니다. 앱 인스턴스 최대 1개 × `APP_DB_POOL`(기본 10) = 10 이 풀러 한도 안에 있어야 합니다.
- [ ] 대기열 깊이 (운영은 예약 실행이 없으므로 잡 주소를 수동으로 부른 직후에만 잠깐 늘었다가 0 으로 돌아와야 정상):

```sql
select count(*) from pgmq.q_jobs;
```

- [ ] 계속 쌓이면 Cloud Run 로그에서 워커 오류를 찾고, `/readyz` 응답을 확인합니다.

## 8. 롤백

- 앱 롤백: Cloud Run 의 이전 리비전으로 트래픽 100% 를 돌립니다.

```sh
gcloud run revisions list --service=bid-radar-lite --region=asia-northeast3 --project=<PROJECT_ID>
gcloud run services update-traffic bid-radar-lite --to-revisions=<이전 리비전>=100 --region=asia-northeast3 --project=<PROJECT_ID>
```

- 마이그레이션은 되돌리지 않습니다 (새 마이그레이션은 표·열을 더하기만 합니다). 데이터가 손상됐다면 6단계의 PITR 로 손상 직전 시점으로 복원합니다.
