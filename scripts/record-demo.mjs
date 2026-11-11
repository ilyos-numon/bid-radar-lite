// README 용 30초 데모 GIF 를 만든다. 데모가 켜진(APP_DEMO=1) 앱을 브라우저로 한 바퀴 돌며 녹화하고 ffmpeg 로 GIF 로 바꾼다.
// 사용: node scripts/record-demo.mjs --base-url http://localhost:<포트> [--out assets/demo.gif] [--seconds 30]
// 동선: 첫 화면 → 데모로 둘러보기 → 오늘의 공고 → 첫 카드 '왜 추천됐나' 펼침 → 관심 공고 → 업무 분배 → 요금제 → 서비스 현황
// 녹화 전에 데모 회사가 있어야 한다 (GET /api/jobs/demo-reset 를 한 번 부른다).
// ffmpeg 가 없으면 녹화본(.webm)을 --out 옆에 남기고 변환 명령을 출력한 뒤 종료 코드 2 로 끝난다.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_OUT = 'assets/demo.gif';
export const DEFAULT_SECONDS = 30;
export const VIEWPORT = { width: 1200, height: 750 };
export const GIF_FILTER = 'fps=6,scale=760:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
const FFMPEG_CANDIDATES = ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
const DEMO_BUTTON = '데모로 둘러보기';

/**
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ baseUrl: string, out: string, seconds: number }}
 */
export function parseArgs(argv) {
  const opts = { baseUrl: '', out: DEFAULT_OUT, seconds: DEFAULT_SECONDS };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--base-url' || flag === '--out' || flag === '--seconds') {
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      i++;
      if (flag === '--base-url') opts.baseUrl = value.replace(/\/+$/, '');
      else if (flag === '--out') opts.out = value;
      else {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 10 || n > 120) throw new Error('--seconds must be an integer 10..120');
        opts.seconds = n;
      }
    } else {
      throw new Error(`unknown option ${flag}`);
    }
  }
  if (!opts.baseUrl) throw new Error('--base-url is required');
  if (!/^https?:\/\//.test(opts.baseUrl)) throw new Error('--base-url must start with http:// or https://');
  return opts;
}

/** ffmpeg 인자 (webm → 팔레트 GIF). seconds 로 길이를 자른다 */
export function ffmpegArgs(input, output, seconds) {
  return ['-y', '-i', input, '-t', String(seconds), '-vf', GIF_FILTER, output];
}

/** webm 을 남길 경로: --out 과 같은 폴더의 같은 이름 .webm */
export function webmPathFor(out) {
  const ext = path.extname(out);
  return `${ext ? out.slice(0, -ext.length) : out}.webm`;
}

function findFfmpeg() {
  for (const bin of FFMPEG_CANDIDATES) {
    const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
    if (!r.error && r.status === 0) return bin;
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

async function goto(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

/** 천천히 아래로 조금 내렸다가 다시 올린다 (화면이 멈춰 보이지 않게) */
async function glance(page, ms) {
  const half = Math.max(0, ms / 2 - 400);
  await sleep(half);
  await page.mouse.wheel(0, 320);
  await sleep(400);
  await page.mouse.wheel(0, -320);
  await sleep(400);
}

async function clickDemo(page, baseUrl) {
  const button = page.getByRole('button', { name: DEMO_BUTTON });
  if (await button.first().isVisible({ timeout: 5000 }).catch(() => false)) {
    await Promise.all([page.waitForURL(/\/today/, { timeout: 15000 }), button.first().click()]);
    return;
  }
  // 버튼이 보이지 않으면 같은 폼 전송을 직접 한다 (같은 출처 POST)
  await Promise.all([
    page.waitForURL(/\/today/, { timeout: 15000 }),
    page.evaluate((action) => {
      const f = document.createElement('form');
      f.method = 'post';
      f.action = action;
      document.body.appendChild(f);
      f.submit();
    }, `${baseUrl}/demo/login`),
  ]);
}

async function openFirstExplain(page) {
  const summary = page.locator('details.explain > summary').first();
  if (await summary.isVisible({ timeout: 3000 }).catch(() => false)) {
    await summary.scrollIntoViewIfNeeded();
    await summary.click();
  }
}

/** 단계마다 끝나는 시각을 정해 두고 그때까지 머문다. 전체 길이가 seconds 에 맞춰진다 */
export async function walk(page, baseUrl, seconds) {
  const steps = [
    async () => goto(page, `${baseUrl}/welcome`),
    async () => clickDemo(page, baseUrl),
    async () => openFirstExplain(page),
    async () => goto(page, `${baseUrl}/interest`),
    async () => goto(page, `${baseUrl}/assign`),
    async () => goto(page, `${baseUrl}/billing`),
    async () => goto(page, `${baseUrl}/status`),
  ];
  const slot = (seconds * 1000) / steps.length;
  const start = Date.now();
  for (let i = 0; i < steps.length; i++) {
    await steps[i]();
    const left = start + (i + 1) * slot - Date.now();
    if (i === 2 || i === 0) await sleep(left);
    else await glance(page, left);
    const rest = start + (i + 1) * slot - Date.now();
    if (rest > 0) await sleep(rest);
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.log(`RECORD_ARG_ERROR ${e.message}`);
    process.exit(1);
  }
  const out = path.resolve(opts.out);
  mkdirSync(path.dirname(out), { recursive: true });
  const videoDir = mkdtempSync(path.join(os.tmpdir(), 'record-demo-'));

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  let webm;
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: videoDir, size: VIEWPORT }, locale: 'ko-KR' });
    const page = await context.newPage();
    const video = page.video();
    try {
      await walk(page, opts.baseUrl, opts.seconds);
    } finally {
      await context.close();
    }
    webm = await video.path();
  } catch (e) {
    console.log(`RECORD_FAIL ${e.message}`);
    await browser.close();
    rmSync(videoDir, { recursive: true, force: true });
    process.exit(1);
  }
  await browser.close();

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    const keep = webmPathFor(out);
    copyFileSync(webm, keep);
    rmSync(videoDir, { recursive: true, force: true });
    const rel = (p) => path.relative(process.cwd(), p) || p;
    console.log(`RECORD_NO_FFMPEG video kept at ${rel(keep)}`);
    console.log(`convert manually: ffmpeg ${ffmpegArgs(rel(keep), rel(out), opts.seconds).map((a) => (/[\s;[\]]/.test(a) ? `"${a}"` : a)).join(' ')}`);
    process.exit(2);
  }

  const r = spawnSync(ffmpeg, ffmpegArgs(webm, out, opts.seconds), { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  rmSync(videoDir, { recursive: true, force: true });
  if (r.status !== 0) {
    console.log(`RECORD_FAIL ffmpeg exit ${r.status}`);
    process.stdout.write(String(r.stderr ?? '').split('\n').slice(-10).join('\n'));
    process.exit(1);
  }
  console.log(`RECORD_OK ${path.relative(process.cwd(), out) || out} ${statSync(out).size} bytes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
