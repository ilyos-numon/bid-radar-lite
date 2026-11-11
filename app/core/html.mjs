// 공통 화면: 레이아웃·메뉴·작은 출력 도우미. 화면에 나가는 글자는 전부 esc 를 거친다.
// 이 파일은 화면 용어 검사 대상이다 (주석 포함). 바깥 주소(글꼴·그림·스크립트)는 쓰지 않는다.

import { footerHtml } from './legal/business.mjs';

export const GROUPS = ['매일', '공고 더 알기', '더 넓게', '설정'];

// 아이콘: 24 칸 기준 선 그림. 그림 모양은 디자인 시안에서 옮겼다.
const ICONS = {
  radar: { inner: '<circle cx="12" cy="12" r="8"></circle><circle cx="12" cy="12" r="3.5"></circle><path d="M12 12l5.5-5.5"></path>', sw: '2' },
  calendar: { d: 'M7 3v3 M17 3v3 M4 9h16 M5 5h14v15H5z M9 13h2v2H9z' },
  bookmark: { d: 'M6 4h12v16l-6-4-6 4z' },
  'bookmark-fill': { d: 'M6 4h12v16l-6-4-6 4z', fill: true },
  users: { d: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3 20c0-3 2.7-5 6-5s6 2 6 5 M16 5.5a3 3 0 0 1 0 5.5 M18 15c2 .6 3 2.4 3 5' },
  'user-plus': { d: 'M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M3 20c0-3.3 3.1-5.5 7-5.5 1.3 0 2.5.2 3.5.7 M18 14v6 M15 17h6' },
  file: { d: 'M7 3h7l5 5v13H7z M14 3v5h5 M10 12h6 M10 16h6' },
  building: { d: 'M4 21V5l8-2v18 M12 8h8v13 M3 21h18 M8 8h.01 M8 12h.01 M8 16h.01 M16 12h.01 M16 16h.01' },
  leaf: { d: 'M12 21V11 M12 11c0-4 3-6 7-6 0 4-3 6-7 6z M12 14c0-3-2.5-5-6-5 0 3.5 2.5 5 6 5z' },
  tag: { d: 'M3 12V4h8l10 10-8 8z M7.5 8h.01' },
  rss: { d: 'M5 19h.01 M5 12a7 7 0 0 1 7 7 M5 5a14 14 0 0 1 14 14' },
  bell: { d: 'M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z M10 20.5a2 2 0 0 0 4 0' },
  'check-circle': { d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12.5l2.5 2.5L16 9.5' },
  'alert-circle': { d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7.5v5.5 M12 16.5h.01' },
  'x-circle': { d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9 9l6 6 M15 9l-6 6' },
  info: { d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5.5 M12 7.5h.01' },
  refresh: { d: 'M20 12a8 8 0 1 1-2.3-5.6 M20 4v5h-5' },
  search: { d: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4', sw: '2' },
  spinner: { d: 'M12 3a9 9 0 1 0 9 9', sw: '2' },
  clock: { d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2' },
  grid: { d: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z' },
  'chevron-left': { d: 'M15 6l-6 6 6 6', sw: '2' },
};

export const MENU_ICONS = {
  today: 'calendar',
  interest: 'bookmark',
  assign: 'users',
  summary: 'file',
  company: 'building',
  support: 'leaf',
  keywords: 'tag',
  sources: 'rss',
  settings: 'bell',
};

// 뱃지 뜻 → 아이콘
const BADGE_ICONS = {
  interest: 'bookmark',
  'interest-on': 'bookmark-fill',
  assign: 'user-plus',
  'assign-set': 'users',
  summary: 'file',
  ok: 'check-circle',
  check: 'alert-circle',
  no: 'x-circle',
};

const NOTICE_ICONS = { info: 'info', success: 'check-circle', warn: 'alert-circle' };

const TAB_IDS = ['today', 'interest', 'assign'];
// 사이드바 아래 안내. 화면 본문에 같은 문장이 이미 있으면(알림 설정) 한 화면에 두 번 쓰지 않는다.
const MENU_NOTE = '알림은 매일 아침 8시쯤 갑니다.';
const MENU_NOTE_OFF = '알림 예약 실행이 꺼져 있습니다.';
// 예약 실행을 끈 운영(APP_SCHEDULER_OFF=1)에서 `?` 아이콘에 보이는 안내
export const SCHEDULE_OFF_TIP = '비용 절감을 위해 예약 실행을 꺼 두었습니다. 공고는 하루 첫 방문 때 가져오고, 알림과 자동 결제는 보내지 않습니다.';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const CSS = `
:root{--bg:#F4F6F9;--surface:#FFFFFF;--line:#E3E7ED;--line-input:#C4CAD1;--ink:#191F28;--ink-2:#4E5968;--ink-3:#6B7684;--ink-body:#333D4B;--focus:#F2A900;--primary:#1C4FBF;--primary-hover:#163F99;--primary-soft:#EEF3FF;--primary-line:#C9D6F2;--soon:#C2410C;--soon-bg:#FFF2EA;--summary:#6D28D9;--ok:#11692F;--ok-bg:#ECF8F0;--ok-line:#BFE5CC;--check:#8A5300;--check-bg:#FDF6E3;--check-line:#F0DFB0;--no:#B91C1C;--no-bg:#FDEDED;--no-line:#F3C7C7;--no-ink:#8E1616;--reasons-bg:#F6F8FB;--chip-bg:#F2F4F6;--divider:#EEF0F3;--hairline:#D1D6DB;--muted-dot:#8B95A1}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;font-size:15px;color:var(--ink);background:var(--bg);line-height:1.6;word-break:keep-all;overflow-wrap:anywhere}
a{color:var(--primary)}
a:hover{color:var(--primary-hover)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
svg.icon{flex:none;vertical-align:middle}
.skip{position:absolute;left:-999px;top:0;background:var(--surface);padding:8px;z-index:30}
.skip:focus{left:8px}
header.top{min-height:64px;background:var(--surface);border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;padding:10px 24px}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink)}
.brand:hover{color:var(--ink)}
.logo{flex:none;width:32px;height:32px;border-radius:9px;background:var(--primary);color:#FFFFFF;display:flex;align-items:center;justify-content:center}
.brand .name{font-size:17px;font-weight:700;letter-spacing:-0.02em}
.brand .sep{width:1px;height:14px;background:var(--hairline)}
.brand .company{font-size:15px;color:var(--ink-2)}
.who{display:flex;align-items:center;gap:10px;font-size:14px}
.who a.me{display:flex;align-items:center;gap:10px;min-height:44px;text-decoration:none;color:var(--ink)}
.avatar{flex:none;width:32px;height:32px;border-radius:50%;background:var(--primary-soft);color:var(--primary);font-size:14px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}
.who .member{font-weight:500}
.who .role{font-size:12px;font-weight:500;color:var(--primary);background:var(--primary-soft);padding:2px 8px;border-radius:6px}
.who .dot{color:var(--line-input)}
.who a.logout{color:var(--ink-2);text-decoration:none;min-height:44px;display:inline-flex;align-items:center}
.who .logout-form{display:inline-flex;margin:0}
.who button.logout,.who button.logout:hover{font:inherit;font-size:14px;font-weight:400;color:var(--ink-2);background:none;border:0;border-radius:0;padding:0;min-height:44px;line-height:inherit;cursor:pointer}
.shell{min-height:calc(100vh - 64px)}
nav.menu{background:var(--surface);border-right:1px solid var(--line);padding:24px 12px;display:flex;flex-direction:column;gap:22px}
nav.menu ul{margin:0;padding:0;list-style:none}
nav.menu .groups{display:flex;flex-direction:column;gap:22px}
nav.menu .group-name{display:block;margin:0 0 6px;padding:0 12px;font-size:12px;font-weight:500;color:var(--ink-3);letter-spacing:0.02em}
nav.menu ul.items{display:flex;flex-direction:column;gap:2px}
nav.menu ul.items li{position:relative}
nav.menu ul.items a{display:flex;align-items:center;min-height:44px;padding:0 12px 0 44px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:500;color:var(--ink-body)}
nav.menu ul.items a:hover{background:var(--bg);color:var(--ink)}
nav.menu ul.items li>svg{position:absolute;left:12px;top:12px;pointer-events:none;color:var(--ink-body)}
nav.menu ul.items a[aria-current="page"]{background:var(--primary-soft);color:var(--primary);font-weight:700}
nav.menu ul.items a[aria-current="page"]+svg{color:var(--primary)}
nav.menu .menu-note{margin:0 12px;padding-top:16px;border-top:1px solid var(--divider);font-size:13px;line-height:1.6;color:var(--ink-2)}
.tip{display:inline-flex;width:18px;height:18px;border-radius:50%;border:1px solid var(--divider);font-size:12px;align-items:center;justify-content:center;cursor:help;position:relative;color:var(--ink-2)}
.tip:hover::after,.tip:focus::after{content:attr(data-tip);position:absolute;left:50%;bottom:calc(100% + 6px);transform:translateX(-50%);width:max-content;max-width:260px;padding:8px 10px;border-radius:8px;background:var(--ink);color:#fff;font-size:12px;line-height:1.5;white-space:normal;z-index:10}
main{display:block;min-width:0}
.page{max-width:880px;margin:0 auto;display:flex;flex-direction:column;gap:20px}
main.wide .page{max-width:960px}
.page>*{margin-top:0;margin-bottom:0}
.page-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:16px}
.page-head>div:first-child{display:flex;flex-direction:column;gap:6px;min-width:0}
.page-head .actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.eyebrow{margin:0;font-size:13px;font-weight:500;color:var(--ink-2)}
h1{margin:0;font-size:28px;line-height:1.3;font-weight:700;letter-spacing:-0.02em}
h2,h3{letter-spacing:-0.01em}
p.help{margin:0;font-size:15px;color:var(--ink-2)}
.count{color:var(--primary);font-variant-numeric:tabular-nums}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:22px 24px;margin:0 0 12px}
li.card:last-child{margin-bottom:0}
.title{font-size:18px;font-weight:700;line-height:1.45}
.org,.facts,.date{color:var(--ink-2);font-size:14px}
.facts,.date{font-variant-numeric:tabular-nums}
.reasons{margin:0;padding:8px 12px;border-radius:10px;background:var(--reasons-bg);font-size:14px;color:var(--ink-body)}
.reasons strong{color:var(--primary);margin-right:6px}
.badges{display:flex;flex-wrap:wrap;gap:8px}
.badge{display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:0 14px;border-radius:10px;border:1px solid var(--line);background:var(--surface);color:var(--ink-body);font-size:14px;font-weight:500;text-decoration:none;vertical-align:middle}
a.badge:hover{border-color:var(--primary-line);color:var(--ink)}
.badge.kind-interest-on{border-color:var(--primary-line);background:var(--primary-soft);color:var(--primary)}
.badge.kind-summary svg{color:var(--summary)}
.badge.kind-ok{border-color:var(--ok-line);background:var(--ok-bg);color:var(--ok)}
.badge.kind-check{border-color:var(--check-line);background:var(--check-bg);color:var(--check)}
.badge.kind-no{border-color:var(--no-line);background:var(--no-bg);color:var(--no)}
.dday{display:inline-block;flex:none;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;padding:5px 12px;border-radius:8px;background:var(--chip-bg);color:var(--ink-body);white-space:nowrap}
.dday.soon{background:var(--soon-bg);color:var(--soon)}
.dday.past{font-weight:500;color:var(--ink-2)}
.kind-chip{display:inline-block;flex:none;font-size:13px;font-weight:700;padding:3px 10px;border-radius:8px;background:var(--check-bg);color:var(--check);border:1px solid var(--check-line);white-space:nowrap;vertical-align:middle}
.kind-chip.kind-cancelled{background:var(--no-bg);color:var(--no);border-color:var(--no-line)}
.kind-chip.kind-awarded{background:var(--ok-bg);color:var(--ok);border-color:var(--ok-line)}
.kind-chip.kind-top{/* 기본 kind-chip 색(check) 유지, 선택자만 추가 */}
.flow{margin:0;font-size:14px;color:var(--ink-2)}
.dday.unknown{font-weight:500;background:var(--surface);border:1px dashed #B0B8C1;color:var(--ink-2)}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:500;padding:2px 10px;border-radius:999px;background:var(--chip-bg);color:var(--ink-2)}
.banner.demo{width:100%;background:#FFF4C2;border-bottom:1px solid var(--check-line);color:var(--ink-body);font-size:13px;line-height:1.5;padding:8px clamp(16px,4vw,48px)}
main.bare .banner.demo{border:1px solid var(--check-line);border-radius:10px;padding:8px 12px}
.chip.example{display:inline-block;flex:none;font-size:12px;font-weight:500;padding:1px 8px;border-radius:999px;border:1px solid var(--line-input);background:var(--surface);color:var(--ink-2);white-space:nowrap;vertical-align:middle}
.chip.credits{display:inline-flex;align-items:center;flex:none;font-size:13px;font-weight:500;padding:2px 10px;border-radius:999px;background:var(--chip-bg);color:var(--ink-2);white-space:nowrap}
.chip.credits.none{background:var(--check-bg);color:var(--check)}
details.explain{font-size:14px;color:var(--ink-body)}
details.explain summary{cursor:pointer;font-weight:500;min-height:32px;display:flex;align-items:center}
.explain ul{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}
.explain li{display:flex;gap:8px;align-items:baseline}
.explain li .state{flex:none;font-size:12px;font-weight:700;padding:1px 8px;border-radius:6px;background:var(--chip-bg);color:var(--ink-2)}
.explain li[data-ok="true"] .state{background:var(--ok-bg);color:var(--ok)}
.explain li[data-ok="false"] .state{background:var(--no-bg);color:var(--no)}
.explain li[data-ok="null"] .state{background:var(--chip-bg);color:var(--ink-3)}
.pill.on{background:var(--ok-bg);color:var(--ok)}
.empty{display:flex;flex-direction:column;align-items:center;gap:12px;padding:28px 20px;border-radius:14px;border:1px dashed var(--line-input);background:#FBFCFD;text-align:center;margin:0 0 16px}
.empty p{margin:0;font-size:15px;color:var(--ink-body)}
.empty .button.secondary{min-height:44px;font-size:14px}
.error{padding:14px 16px;border-radius:12px;background:var(--no-bg);border:1px solid var(--no-line);color:var(--no-ink);font-size:14px;margin:0 0 12px}
.error p{margin:0;display:flex;align-items:flex-start;gap:8px;font-weight:700}
.error p svg{margin-top:2px}
.error ul{margin:6px 0 0;padding:0 0 0 2.6em;list-style:disc outside;line-height:1.7}
.error li+li{margin-top:2px}
.notice{padding:12px 16px;border-radius:12px;background:var(--primary-soft);border:1px solid var(--primary-line);color:var(--ink-body);font-size:14px;font-weight:500;margin:0 0 12px}
.notice p{margin:0;display:flex;align-items:flex-start;gap:10px}
.notice p svg{margin-top:2px}
.notice.success,.notice[role="status"]{background:var(--ok-bg);border-color:var(--ok-line);color:var(--ok)}
.notice.info[role="status"]{background:var(--primary-soft);border-color:var(--primary-line);color:var(--ink-body)}
.notice.warn{background:var(--check-bg);border-color:var(--check-line);color:var(--check)}
form.stack{display:grid;gap:18px;max-width:560px}
fieldset{border:0;margin:0;padding:0;min-width:0}
legend{padding:0;font-size:18px;font-weight:700}
label{display:grid;gap:6px;font-size:14px;font-weight:700}
input:not([type=checkbox]):not([type=radio]):not([type=hidden]),select,textarea{font:inherit;font-size:15px;font-weight:400;color:var(--ink);min-height:48px;padding:0 14px;border:1px solid var(--line-input);border-radius:10px;background:var(--surface);width:100%}
textarea{padding:12px 14px}
input[type=checkbox],input[type=radio]{width:20px;height:20px;accent-color:var(--primary)}
[aria-invalid="true"]{border:1.5px solid var(--no)!important}
label span,.hint{font-size:13px;font-weight:400;color:var(--ink-2)}
button,.button{font:inherit;font-size:15px;font-weight:700;min-height:48px;padding:0 24px;border:1px solid var(--primary);border-radius:10px;background:var(--primary);color:#FFFFFF;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;line-height:1.3;vertical-align:middle}
button:hover,.button:hover{background:var(--primary-hover);border-color:var(--primary-hover);color:#FFFFFF}
.button.secondary,button.secondary{background:var(--surface);color:var(--primary);border-color:var(--primary-line);font-weight:500;padding:0 18px}
.button.secondary:hover,button.secondary:hover{background:var(--primary-soft);border-color:var(--primary-line);color:var(--primary-hover)}
.button.secondary.quiet,button.secondary.quiet{color:var(--ink-2);border-color:var(--line)}
.button.small,button.small{min-height:40px;padding:0 14px;font-size:14px}
button:disabled,button[aria-busy="true"]{background:var(--chip-bg);border-color:var(--line);color:var(--ink-2);cursor:default}
button[aria-busy="true"]::before{content:"";width:16px;height:16px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:spin 0.9s linear infinite}
svg.icon-spinner{animation:spin 0.9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){button[aria-busy="true"]::before,svg.icon-spinner{animation:none}}
table{border-collapse:collapse;width:100%}
th,td{border-bottom:1px solid var(--divider);padding:8px 6px;text-align:left;vertical-align:top}
details>summary{cursor:pointer}
nav.tabs{display:none}
body.bare{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 16px 96px}
main.bare{position:relative;width:100%;max-width:460px;background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:40px clamp(20px,6vw,40px);display:flex;flex-direction:column;gap:28px}
main.bare .brand-row{display:flex;align-items:center;gap:10px}
main.bare .brand-row .logo{width:36px;height:36px;border-radius:10px}
main.bare .brand-row .name{font-size:18px;font-weight:700;letter-spacing:-0.02em}
main.bare .page-head>div:first-child{gap:8px}
main.bare h1{font-size:26px;line-height:1.35}
main.bare form.stack{max-width:none}
main.bare input:not([type=checkbox]):not([type=radio]):not([type=hidden]){min-height:52px;padding:0 16px;border-radius:12px;font-size:16px}
main.bare form.stack>button{margin-top:6px;width:100%;min-height:54px;border-radius:12px;font-size:16px}
main.bare .bare-foot{margin:0;padding-top:20px;border-top:1px solid var(--divider);font-size:13px;color:var(--ink-2)}
label.check{display:flex;align-items:flex-start;gap:10px;font-weight:500}
label.check input{flex:none;margin-top:1px}
fieldset.consents{display:grid;gap:10px}
.legal-doc h2{font-size:16px;margin:16px 0 6px}
.legal-doc p{margin:0 0 8px;font-size:14px;line-height:1.7}
footer.legal{margin-top:8px;padding-top:16px;border-top:1px solid var(--divider);font-size:12px;line-height:1.7;color:var(--ink-2)}
footer.legal p{margin:0;display:flex;flex-wrap:wrap;gap:0 6px}
footer.legal .unset{font-weight:700}
main.bare .bare-after{position:absolute;top:100%;left:0;right:0;margin:20px 0 0;font-size:14px;color:var(--ink-2);text-align:center}
.me-card .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:0 0 20px}
.me-card .tiles>div{padding:14px 16px;border-radius:12px;background:var(--reasons-bg);border:1px solid var(--line)}
.me-card dt{font-size:13px;font-weight:500;color:var(--ink-2)}
.me-card dd{margin:2px 0 0;font-size:16px;font-weight:700}
.me-card p{margin:0}
@media (min-width:900px){
.shell.with-menu{display:grid;grid-template-columns:232px minmax(0,1fr)}
main#main:not(.bare){padding:36px clamp(16px,4vw,48px) 72px}
}
@media (max-width:899px){
footer.legal p.biz{flex-direction:column}
footer.legal p.biz .sep{display:none}
header.top{min-height:56px;padding:6px 8px 6px 16px;flex-wrap:nowrap}
.brand{gap:8px;min-width:0}
.logo{width:28px;height:28px;border-radius:8px}
.brand .name{font-size:16px;white-space:nowrap}
.brand .sep{display:none}
.brand .company{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.who .member,.who .role,.who .dot,.who a.logout,.who .logout-form{display:none}
.who a.me{width:44px;height:44px;justify-content:center}
.shell{min-height:0}
nav.menu{display:none}
main#main:not(.bare){padding:20px 16px 96px}
.page{gap:14px}
.page-head{align-items:flex-start}
h1{font-size:22px;line-height:1.35}
p.help{font-size:14px}
.card{padding:16px}
.title{font-size:17px}
.badge{min-height:44px;font-size:13px;padding:0 12px}
nav.tabs{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:20;height:72px;background:var(--surface);border-top:1px solid var(--line);padding:4px 4px 8px}
nav.tabs>a,nav.tabs summary{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-width:0;text-decoration:none;color:var(--ink-2);font-size:12px;font-weight:500;line-height:1.3}
nav.tabs>a[aria-current="page"],nav.tabs summary.on{color:var(--primary);font-weight:700}
nav.tabs details.more{flex:1;display:flex}
nav.tabs summary{height:100%;list-style:none}
nav.tabs summary::-webkit-details-marker{display:none}
nav.tabs .more-panel{position:fixed;left:0;right:0;bottom:72px;max-height:calc(100vh - 140px);overflow-y:auto;background:var(--surface);border-top:1px solid var(--line);box-shadow:0 -8px 24px rgba(25,31,40,0.08);padding:16px 12px;display:flex;flex-direction:column;gap:2px}
nav.tabs .more-panel .group-name{margin:10px 12px 4px;font-size:12px;font-weight:500;color:var(--ink-3)}
nav.tabs .more-panel .group-name:first-child{margin-top:0}
nav.tabs .more-panel a{display:flex;align-items:center;gap:12px;min-height:48px;padding:0 12px;border-radius:10px;text-decoration:none;color:var(--ink-body);font-size:15px;font-weight:500}
nav.tabs .more-panel a[aria-current="page"]{background:var(--primary-soft);color:var(--primary);font-weight:700}
}
`;

// 오래 걸리는 버튼의 진행 표시와 예산 입력 아래 읽기 쉬운 금액 (바깥 주소 없음)
const SCRIPT = `
(function () {
  document.addEventListener('submit', function (e) {
    var b = e.submitter || e.target.querySelector('button[data-busy]');
    if (!b || !b.dataset || !b.dataset.busy) return;
    if (b.getAttribute('aria-busy') === 'true') { e.preventDefault(); return; }
    setTimeout(function () {
      b.disabled = true;
      b.setAttribute('aria-busy', 'true');
      b.textContent = b.dataset.busy;
    }, 0);
  });
  function amount(v) {
    var s = String(v || '').replace(/[^0-9]/g, '');
    if (s === '') return '';
    var won = Number(s);
    if (won >= 100000000) return (won / 1e8).toFixed(1).replace(/\\.0$/, '') + '억';
    return Math.round(won / 10000) + '만';
  }
  function hint(input) {
    var id = input.getAttribute('data-amount-hint') || (input.id + '-hint');
    var out = document.getElementById(id);
    if (out) out.textContent = amount(input.value);
  }
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t && t.matches && t.matches('input[data-amount-hint]')) hint(t);
  });
  document.querySelectorAll('input[data-amount-hint]').forEach(hint);
})();
`;

/** @param {unknown} s */
export function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** @param {string[]} list → '왜 추천: a · b' (비어 있으면 '') */
export function reasons(list) {
  const items = (Array.isArray(list) ? list : []).filter((r) => r !== null && r !== undefined && String(r) !== '');
  if (items.length === 0) return '';
  return esc('왜 추천: ' + items.join(' · '));
}

function dayNumber(value) {
  let s = value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').trim();
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : Math.round(t / 86400000);
}

/**
 * @param {string|null|undefined} deadline 'YYYY-MM-DD HH:MM:SS' 등 (Asia/Seoul 기준). '9999-' 로 시작하거나 비면 마감 미확인
 * @param {string|Date} today 'YYYY-MM-DD'
 * @returns {string} 'D-9 10:00' | 'D-9'(시각 없음) | '마감 지남' | '마감 미확인'
 */
export function dday(deadline, today) {
  const raw = String(deadline ?? '').trim();
  if (raw === '' || raw.startsWith('9999-')) return '마감 미확인';
  const d = dayNumber(raw);
  const t = dayNumber(today);
  if (d === null || t === null) return '마감 미확인';
  const diff = d - t;
  if (diff < 0) return '마감 지남';
  const time = /^\d{4}-?\d{2}-?\d{2}[ T](\d{2}):(\d{2})/.exec(raw);
  return 'D-' + diff + (time ? ` ${time[1]}:${time[2]}` : '');
}

function sentence(s) {
  const v = String(s ?? '').trim();
  if (v === '') return '';
  return /[.!?。]$/.test(v) ? v : v + '.';
}

/**
 * @param {string} name ICONS 이름. 모르는 이름이면 ''
 * @param {{size?: number}} [opts]
 */
export function icon(name, { size = 16 } = {}) {
  const def = Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : null;
  if (!def) return '';
  const n = Number(size) > 0 ? Number(size) : 16;
  const inner = def.inner ?? `<path d="${def.d}"></path>`;
  return `<svg class="icon icon-${name}" aria-hidden="true" focusable="false" width="${n}" height="${n}" viewBox="0 0 24 24" fill="${def.fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="${def.sw ?? '1.8'}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

/** 빈 상태: 한 문장 + 다음 행동 링크 1개 (보조 행동 모양. 주 행동 버튼은 화면이 박스 밖에 둔다) */
export function empty(message, { href, label } = {}) {
  const link = href ? `<p><a class="button secondary" href="${esc(href)}">${esc(label ?? href)}</a></p>` : '';
  return `<div class="empty"><p>${esc(sentence(message))}</p>${link}</div>`;
}

/** 오류: '<무엇이 안 됐는지>. <다음에 할 일>.' 항목이 여럿이면 화면이 이 박스 안 끝에 <ul> 을 붙인다 */
/** `?` 아이콘. 마우스를 올리거나 키보드로 초점을 주면 text 가 보인다 */
export function tip(text) {
  return `<span class="tip" tabindex="0" role="note" aria-label="${esc(text)}" data-tip="${esc(text)}">?</span>`;
}

export function error(message, next) {
  const text = [sentence(message), sentence(next)].filter(Boolean).join(' ');
  return `<div class="error" role="alert"><p>${icon('alert-circle', { size: 18 })}${esc(text)}</p></div>`;
}

export function redirect(path, status = 303) {
  return new Response(null, { status, headers: { location: String(path) } });
}

/**
 * D-day 칩. 3일 이하(0~3)는 soon(주황). 보이는 글자는 'D-5' 이고 읽는 글자는 '마감 D-5'.
 * prefix 가 있으면 '신청 마감 D-12' 처럼 '마감 ' 도 보이게 쓴다.
 */
export function ddayChip(deadline, today, { prefix = '' } = {}) {
  const label = dday(deadline, today);
  const past = label === '마감 지남';
  const unknown = label === '마감 미확인';
  const m = /^D-(\d+)/.exec(label);
  const diff = m ? Number(m[1]) : null;
  const soon = diff !== null && diff >= 0 && diff <= 3;
  const cls = `dday${soon ? ' soon' : ''}${past ? ' past' : ''}${unknown ? ' unknown' : ''}`;
  let text;
  if (past || unknown) text = esc(prefix) + esc(label);
  else if (prefix) text = `${esc(prefix)}마감 ${esc(label)}`;
  else text = `<span class="skip">마감 </span>${esc(label)}`;
  return `<span class="${cls}">${text}</span>`;
}

function weekday(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(t.getTime()) || t.getUTCMonth() !== m - 1) return null;
  return WEEKDAYS[t.getUTCDay()];
}

/** 'YYYY-MM-DD' → '10/30(금)'. 읽지 못하면 '' */
export function shortDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? '').trim());
  if (!m) return '';
  const w = weekday(Number(m[1]), Number(m[2]), Number(m[3]));
  if (!w) return '';
  return `${m[2]}/${m[3]}(${w})`;
}

/** 'YYYY-MM-DD HH:MM[:SS]' → '11/04(수) 18:00'. 비었거나 '9999-' 로 시작하면 '' */
export function dateTime(deadline) {
  const raw = String(deadline ?? '').trim();
  if (raw === '' || raw.startsWith('9999-')) return '';
  const date = shortDate(raw);
  if (!date) return '';
  const t = /^\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})/.exec(raw);
  return esc(t ? `${date} ${t[1]}:${t[2]}` : date);
}

/** 개찰일시 'YYYY-MM-DD HH:MM[:SS]' → '개찰 11/08(일) 11:00'. 비었거나 읽지 못하면 '' */
export function openingText(openingAt) {
  const when = dateTime(openingAt);
  return when ? `개찰 ${when}` : '';
}

const KIND_LABELS = { changed: '변경', cancelled: '취소', rebid: '재공고', postponed: '연기', prestd: '사전규격' };

/** 공고 종류 칩. 'changed'→변경, 'cancelled'→취소, 'rebid'→재공고, 'postponed'→연기, 'prestd'→사전규격, 그 외 '' */
export function kindChip(kind) {
  const k = typeof kind === 'string' && Object.prototype.hasOwnProperty.call(KIND_LABELS, kind) ? kind : null;
  if (!k) return '';
  return `<span class="kind-chip kind-${k}">${KIND_LABELS[k]}</span>`;
}

const FLOW_KINDS = ['changed', 'cancelled', 'rebid', 'postponed'];

/** 사전규격·본공고 흐름 줄. 본공고면 '사전규격 있었음[ · 의견마감 …]', 사전규격이면 '본공고 나옴 → …', 연결이 없으면 '' */
export function flowLine(flow) {
  if (!flow || typeof flow !== 'object') return '';
  const p = flow.prestd;
  if (p) {
    const when = p.stored ? dateTime(p.deadline) : '';
    return `<p class="flow">사전규격 있었음${when ? ` · 의견마감 ${when}` : ''}</p>`;
  }
  const list = Array.isArray(flow.notices) ? flow.notices : [];
  const n = list[0];
  if (!n) return '';
  if (!n.stored) return `<p class="flow">본공고 나옴 → 공고번호 ${esc(n.noticeNo)}</p>`;
  const url = typeof n.url === 'string' && /^https?:\/\//i.test(n.url) ? n.url : '';
  let out = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(n.title)}</a>` : esc(n.title);
  if (FLOW_KINDS.includes(n.kind)) out += ` ${kindChip(n.kind)}`;
  if (list.length > 1) out += ` 외 ${list.length - 1}건`;
  return `<p class="flow">본공고 나옴 → ${out}</p>`;
}

/** 공고 카드 뱃지. kind 가 정해진 8개가 아니면 아이콘 없는 중립 뱃지 */
export function badge({ label, href, kind } = {}) {
  const known = typeof kind === 'string' && Object.prototype.hasOwnProperty.call(BADGE_ICONS, kind);
  const cls = known ? `badge kind-${kind}` : 'badge';
  const ico = known ? icon(BADGE_ICONS[kind], { size: 16 }) : '';
  if (!href) return `<span class="${cls}">${ico}${esc(label)}</span>`;
  return `<a class="${cls}" href="${esc(href)}">${ico}${esc(label)}</a>`;
}

/** 안내 박스. kind: info | success | warn. html=true 면 message 를 이미 처리된 조각으로 본다 */
export function notice(message, { kind = 'info', role, html = false } = {}) {
  const k = Object.prototype.hasOwnProperty.call(NOTICE_ICONS, kind) ? kind : 'info';
  const text = html ? String(message ?? '') : esc(message);
  return `<div class="notice ${k}"${role ? ` role="${esc(role)}"` : ''}><p>${icon(NOTICE_ICONS[k], { size: 18 })}${text}</p></div>`;
}

/** 이름 첫 글자 동그라미 (읽는 사람에게는 숨김) */
export function avatar(name, { size = 32 } = {}) {
  const first = Array.from(String(name ?? '').trim())[0] ?? '';
  const n = Number(size);
  const style = n > 0 && n !== 32 ? ` style="width:${n}px;height:${n}px;font-size:${Math.round(n * 0.44)}px"` : '';
  return `<span class="avatar" aria-hidden="true"${style}>${esc(first)}</span>`;
}

/** 숫자+단위 강조. count(3, '건') → <span class="count">3건</span> */
export function count(n, unit = '') {
  return `<span class="count">${esc(n)}${esc(unit)}</span>`;
}

/** 데모 회사 목록·카드 제목 옆 칩 */
export function exampleChip() {
  return '<span class="chip example">예시 데이터</span>';
}

function logo(size) {
  return `<span class="logo">${icon('radar', { size })}</span>`;
}

/**
 * @param {{ menus: () => Array<{id:string,title:string,group:string,order:number,path:string,help?:string}>, companyName?: () => string|null|Promise<string|null>, logoutPost?: boolean, env?: Record<string,string|undefined>, banner?: () => string|null }} deps
 *   env: 아래 사업자 정보 줄(BUSINESS_*)을 읽는 곳. 기본 process.env
 *   banner: 위쪽 안내 띠. 이미 이스케이프된 HTML 을 돌려준다. 비면 띠 없음
 */
export function createHtml({ menus, companyName = () => null, logoutPost = false, env = process.env, banner = () => null }) {
  const schedulerOff = env?.APP_SCHEDULER_OFF === '1';

  /** 예약 실행이 켜져 있으면 onText, 꺼져 있으면 offText 와 `?` 안내 (둘 다 이스케이프) */
  function scheduleNote(onText, offText) {
    return schedulerOff ? `${esc(offText)} ${tip(SCHEDULE_OFF_TIP)}` : esc(onText);
  }

  function bannerHtml() {
    const text = typeof banner === 'function' ? banner() : null;
    return text ? `\n<div class="banner demo" role="note">${text}</div>` : '';
  }

  function sorted() {
    const list = menus();
    const out = [];
    for (const g of GROUPS) {
      out.push(
        ...list.filter((m) => m.group === g).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
      );
    }
    return out;
  }

  function isActive(m, active) {
    return active !== undefined && active !== null && (m.id === active || m.path === active);
  }

  function menuIcon(m, size) {
    return icon(MENU_ICONS[m.id] ?? 'grid', { size });
  }

  function nav(list, active, note) {
    if (list.length === 0) return '';
    const groups = GROUPS.map((g) => {
      const items = list.filter((m) => m.group === g);
      if (items.length === 0) return '';
      const links = items
        .map((m) => {
          const cur = isActive(m, active);
          return `<li><a href="${esc(m.path)}" title="${esc(m.help ?? '')}"${cur ? ' aria-current="page"' : ''}>${esc(m.title)}</a>${menuIcon(m, 20)}</li>`;
        })
        .join('');
      return `<li><span class="group-name">${esc(g)}</span><ul class="items">${links}</ul></li>`;
    }).join('');
    return `<nav class="menu" aria-label="메뉴"><ul class="groups">${groups}</ul>${note ? `<p class="menu-note">${scheduleNote(MENU_NOTE, MENU_NOTE_OFF)}</p>` : ''}</nav>`;
  }

  function tabs(list, active) {
    if (list.length === 0) return '';
    const link = (m, size) =>
      `<a href="${esc(m.path)}"${isActive(m, active) ? ' aria-current="page"' : ''}>${menuIcon(m, size)}<span>${esc(m.title)}</span></a>`;
    const first = TAB_IDS.map((id) => list.find((m) => m.id === id)).filter(Boolean);
    const rest = list.filter((m) => !TAB_IDS.includes(m.id));
    let more = '';
    if (rest.length > 0) {
      const on = rest.some((m) => isActive(m, active));
      const panel = GROUPS.map((g) => {
        const items = rest.filter((m) => m.group === g);
        if (items.length === 0) return '';
        return `<p class="group-name">${esc(g)}</p>${items.map((m) => link(m, 20)).join('')}`;
      }).join('');
      more = `<details class="more"><summary${on ? ' class="on"' : ''}>${icon('grid', { size: 24 })}<span>더보기</span></summary><div class="more-panel">${panel}</div></details>`;
    }
    return `<nav class="tabs" aria-label="빠른 메뉴">${first.map((m) => link(m, 24)).join('')}${more}</nav>`;
  }

  function header(member, company) {
    const brand = `<a class="brand" href="/">${logo(18)}<span class="name">입찰 레이더</span>${
      company ? `<span class="sep" aria-hidden="true"></span><span class="company">${esc(company)}</span>` : ''
    }</a>`;
    const who = member
      ? `<div class="who"><a class="me" href="/me" aria-label="${esc(`내 정보 · ${member.name ?? ''}`)}">${avatar(member.name)}<span class="member">${esc(member.name)}</span><span class="role">${member.role === 'owner' ? '대표' : '구성원'}</span></a><span class="dot" aria-hidden="true">·</span>${logoutPost ? '<form class="logout-form" method="post" action="/logout"><button type="submit" class="logout">나가기</button></form>' : '<a class="logout" href="/logout">나가기</a>'}</div>`
      : '';
    return `<header class="top">${brand}${who}</header>`;
  }

  function head({ eyebrowText, heading, help, actions }) {
    return `<div class="page-head"><div>${eyebrowText ? `<p class="eyebrow">${esc(eyebrowText)}</p>` : ''}<h1>${esc(heading ?? '')}</h1>${
      help ? `<p class="help">${esc(help)}</p>` : ''
    }</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
  }

  function document({ title, help, body, member, active, eyebrow, heading, actions, chrome, wide }, company) {
    const bare = chrome === 'bare';
    const list = member && !bare ? sorted() : [];
    let eyebrowText = '';
    if (typeof eyebrow === 'string') eyebrowText = eyebrow;
    else if (eyebrow !== false && !bare) eyebrowText = list.find((m) => isActive(m, active))?.group ?? '';
    const h1 = heading ?? title ?? '';
    const top = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title ? `${title} · 입찰 레이더` : '입찰 레이더')}</title>
<style>${CSS}</style>
</head>`;
    if (bare) {
      return `${top}
<body class="bare">
<a class="skip" href="#main">본문으로 건너뛰기</a>
<main id="main" class="bare">
<div class="brand-row">${logo(20)}<span class="name">입찰 레이더</span></div>${bannerHtml()}
${head({ eyebrowText, heading: h1, help, actions })}
${body ?? ''}
${footerHtml(env)}
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
    }
    const text = String(body ?? '');
    const menu = nav(list, active, !text.includes(MENU_NOTE) && !text.includes(MENU_NOTE_OFF));
    return `${top}
<body>
<a class="skip" href="#main">본문으로 건너뛰기</a>
${header(member, company)}${bannerHtml()}
<div class="shell${menu ? ' with-menu' : ''}">
${menu}
<main id="main"${wide ? ' class="wide"' : ''}><div class="page">
${head({ eyebrowText, heading: h1, help, actions })}
${body ?? ''}
${footerHtml(env)}
</div></main>
</div>
${tabs(list, active)}
<script>${SCRIPT}</script>
</body>
</html>`;
  }

  /** @returns {Promise<Response>} 회사 이름을 기다린 뒤 그린다 */
  async function page(status, opts = {}) {
    const company = opts.chrome === 'bare' ? null : await companyName();
    return new Response(document(opts, company), {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  function layout(opts = {}) {
    return page(200, opts);
  }

  return {
    layout,
    page,
    redirect,
    esc,
    reasons,
    dday,
    empty,
    error,
    icon,
    ddayChip,
    dateTime,
    shortDate,
    openingText,
    kindChip,
    flowLine,
    badge,
    notice,
    avatar,
    count,
    exampleChip,
    schedulerOff,
    scheduleNote,
    tip,
  };
}
