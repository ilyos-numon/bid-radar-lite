// sample.hwpx · corrupt.hwp 를 결정적으로 다시 만든다: node tests/fixtures/docs/make-hwpx.mjs
// 같은 입력이면 실행할 때마다 바이트가 같다 (고정 mtime, 고정 시드).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const dir = path.dirname(fileURLToPath(import.meta.url));
// 로컬 시각 성분으로 DOS 시간이 기록되므로 타임존과 무관하게 같은 바이트가 나온다
const MTIME = new Date(2026, 0, 1, 0, 0, 0);

const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const HS = 'http://www.hancom.co.kr/hwpml/2011/section';

const p = (text) => `<hp:p><hp:run><hp:t>${text}</hp:t></hp:run></hp:p>`;
const cell = (text) => `<hp:tc><hp:subList>${p(text)}</hp:subList></hp:tc>`;
const row = (...cells) => `<hp:tr>${cells.map(cell).join('')}</hp:tr>`;

const section0 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hs:sec xmlns:hs="${HS}" xmlns:hp="${HP}">${[
  p('수원시 가로수 식재공사 입찰공고'),
  p('1. 입찰 참가자격: 조경식재공사업 등록업체'),
  `<hp:p><hp:run><hp:tbl>${[row('구분', '내용'), row('추정가격', '120,000,000원'), row('참가지역', '경기도')].join('')}</hp:tbl></hp:run></hp:p>`,
  `<hp:p><hp:run><hp:t>2. 문의<hp:tab/>계약팀</hp:t></hp:run></hp:p>`,
].join('')}</hs:sec>
`;

const contentHpf = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="section0"/></opf:spine></opf:package>
`;

const zip = zipSync(
  {
    mimetype: [strToU8('application/hwp+zip'), { level: 0 }],
    'version.xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" major="5" minor="1"/>\n'),
    'Contents/content.hpf': strToU8(contentHpf),
    'Contents/section0.xml': strToU8(section0),
  },
  { level: 6, mtime: MTIME },
);
writeFileSync(path.join(dir, 'sample.hwpx'), zip);

// corrupt.hwp: HWP 처럼 보이지 않는 임의 512 바이트 (mulberry32, 시드 20261102)
let seed = 20261102;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const junk = new Uint8Array(512);
for (let i = 0; i < junk.length; i += 1) junk[i] = Math.floor(rand() * 256);
writeFileSync(path.join(dir, 'corrupt.hwp'), junk);
