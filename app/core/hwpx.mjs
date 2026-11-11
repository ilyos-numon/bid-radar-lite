// HWPX (한글 OWPML, zip + XML) 텍스트 추출: fflate 로 풀고 fast-xml-parser 로 읽는다
import { unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

const SECTION_RE = /^Contents\/section(\d+)\.xml$/i;

const parser = new XMLParser({
  preserveOrder: true,
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: false,
});

/** preserveOrder 노드: { tag: children[] } | { '#text': string } */
function tagOf(node) {
  for (const k of Object.keys(node)) if (k !== ':@') return k;
  return '';
}

/** <t> 안의 글자 (tab·lineBreak 포함) */
function runText(children) {
  let s = '';
  for (const n of children) {
    const tag = tagOf(n);
    if (tag === '#text') s += String(n['#text']);
    else if (tag === 'tab') s += '\t';
    else if (tag === 'lineBreak') s += '\n';
    else if (Array.isArray(n[tag])) s += runText(n[tag]);
  }
  return s;
}

/** 표: 셀은 탭, 행은 줄 */
function tableLines(children, out) {
  for (const tr of children) {
    if (tagOf(tr) !== 'tr') continue;
    const cells = [];
    for (const tc of tr.tr) {
      if (tagOf(tc) !== 'tc') continue;
      const parts = [];
      walk(tc.tc, parts);
      cells.push(parts.join(' ').replace(/\s+/g, ' ').trim());
    }
    if (cells.some(Boolean)) out.push(cells.join('\t'));
  }
}

/** 문단은 한 줄, 문단 안의 표·글상자는 그 뒤 줄로 */
function paragraph(children, out) {
  let line = '';
  const nested = [];
  const visit = (nodes) => {
    for (const n of nodes) {
      const tag = tagOf(n);
      if (tag === 't') line += runText(n.t);
      else if (tag === 'tbl') tableLines(n.tbl, nested);
      else if (tag === 'p') paragraph(n.p, nested);
      else if (tag !== '#text' && Array.isArray(n[tag])) visit(n[tag]);
    }
  };
  visit(children);
  if (line.trim()) out.push(line.trimEnd());
  out.push(...nested);
}

function walk(nodes, out) {
  for (const n of nodes) {
    const tag = tagOf(n);
    if (tag === 'p') paragraph(n.p, out);
    else if (tag === 'tbl') tableLines(n.tbl, out);
    else if (tag !== '#text' && Array.isArray(n[tag])) walk(n[tag], out);
  }
}

/** @param {Uint8Array} bytes @returns {Promise<string>} 실패 시 throw */
export async function hwpxText(bytes) {
  const files = unzipSync(bytes, { filter: (f) => SECTION_RE.test(f.name) });
  const names = Object.keys(files).sort((a, b) => Number(SECTION_RE.exec(a)[1]) - Number(SECTION_RE.exec(b)[1]));
  if (names.length === 0) throw new Error('hwpx: no section xml');
  const out = [];
  const decoder = new TextDecoder('utf-8');
  for (const name of names) walk(parser.parse(decoder.decode(files[name])), out);
  return out.join('\n');
}
