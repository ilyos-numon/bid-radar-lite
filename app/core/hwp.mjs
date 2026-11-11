// HWP 5 (한글 바이너리) 텍스트 추출: hwp.js 래퍼 (https://github.com/hahnlee/hwp.js, Apache-2.0)
// hwp.js 는 비활성 저장소라 이 파일 밖으로 내부 구조를 흘리지 않는다.

const TAB = 9;
const LINE_BREAK = 10;

/** 문단 하나: 글자 + 안에 든 표·글상자 */
function paragraphText(p, out) {
  let line = '';
  for (const ch of Array.isArray(p && p.content) ? p.content : []) {
    if (typeof ch.value === 'string') line += ch.value;
    else if (ch.value === TAB) line += '\t';
    else if (ch.value === LINE_BREAK) line += '\n';
  }
  if (line.trim()) out.push(line.trimEnd());
  for (const ctrl of Array.isArray(p && p.controls) ? p.controls : []) controlText(ctrl, out);
}

/** 표는 셀을 탭, 행을 줄바꿈으로. 글상자 등은 안의 문단을 그대로 */
function controlText(ctrl, out) {
  if (!ctrl || !Array.isArray(ctrl.content)) return;
  if ('rowCount' in ctrl) {
    for (const row of ctrl.content) {
      if (!Array.isArray(row)) continue;
      const cells = row.map((cell) => {
        const parts = [];
        for (const p of (cell && cell.items) || []) paragraphText(p, parts);
        return parts.join(' ').replace(/\s+/g, ' ').trim();
      });
      if (cells.some(Boolean)) out.push(cells.join('\t'));
    }
    return;
  }
  for (const box of ctrl.content) {
    for (const p of (box && box.items) || []) paragraphText(p, out);
  }
}

/** @param {Uint8Array} bytes @returns {Promise<string>} 실패 시 throw */
export async function hwpText(bytes) {
  const mod = await import('hwp.js');
  const parse = mod.parse ?? mod.default.parse;
  const doc = parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { type: 'buffer' });
  const out = [];
  for (const section of doc.sections || []) {
    for (const p of section.content || []) paragraphText(p, out);
  }
  return out.join('\n');
}
