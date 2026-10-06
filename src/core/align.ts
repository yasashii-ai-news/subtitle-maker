// 台本の文字列と聞き取った文字列を1文字ずつ対応づける（アフィンギャップの大域アラインメント）

export interface AlignResult {
  /** 台本の各文字に対応する聞き取りの文字の番号（無ければ -1） */
  aToB: Int32Array;
  /** 台本の各文字が完全一致したか */
  exact: Uint8Array;
  /** 台本に対応しない聞き取りの文字の番号 */
  inserted: number[];
}

const MATCH = 3;
const MISMATCH = -1.5;
const GAP_OPEN = -5;
const GAP_EXT = -0.6;
const NEG = -1e9;

/**
 * a（台本）と b（聞き取り）を対応づける。
 * 長い動画でもメモリが足りるよう、対角線のまわりの帯だけを計算する。
 */
export function align(a: string[], b: string[]): AlignResult {
  const n = a.length;
  const m = b.length;
  const aToB = new Int32Array(n).fill(-1);
  const exact = new Uint8Array(n);
  const inserted: number[] = [];
  if (n === 0 || m === 0) {
    for (let j = 0; j < m; j++) inserted.push(j);
    return { aToB, exact, inserted };
  }
  // 帯の幅（全体が小さければ全部を計算する）
  const band = n * m <= 40_000_000 ? Math.max(n, m) : Math.max(3000, Math.abs(n - m) + 2000);
  const lo = new Int32Array(n + 1);
  const hi = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const c = Math.round((i * m) / n);
    lo[i] = Math.max(0, c - band);
    hi[i] = Math.min(m, c + band);
  }
  lo[0] = 0;
  hi[n] = m;
  const rowOff = new Float64Array(n + 2);
  for (let i = 0; i <= n; i++) rowOff[i + 1] = rowOff[i] + (hi[i] - lo[i] + 1);
  const size = rowOff[n + 1];
  // 3つの状態（M: 対応, X: 台本だけ進む, Y: 聞き取りだけ進む）それぞれの戻り先を 2bit ずつ
  const tb = new Uint8Array(size);

  let prevM = new Float64Array(m + 1).fill(NEG);
  let prevX = new Float64Array(m + 1).fill(NEG);
  let prevY = new Float64Array(m + 1).fill(NEG);
  let curM = new Float64Array(m + 1);
  let curX = new Float64Array(m + 1);
  let curY = new Float64Array(m + 1);
  // 行 0
  prevM[0] = 0;
  for (let j = 1; j <= hi[0]; j++) {
    prevY[j] = GAP_OPEN + GAP_EXT * (j - 1);
    tb[rowOff[0] + j - lo[0]] = (j === 1 ? 0 : 2) << 4; // Y は M から開くか Y を続ける
  }
  for (let i = 1; i <= n; i++) {
    // 次の行が読む範囲だけ初期化する
    const f0 = Math.max(0, lo[i] - 1);
    const f1 = Math.min(m, i < n ? hi[i + 1] : m) + 1;
    curM.fill(NEG, f0, f1);
    curX.fill(NEG, f0, f1);
    curY.fill(NEG, f0, f1);
    const ai = a[i - 1];
    const base = rowOff[i] - lo[i];
    for (let j = lo[i]; j <= hi[i]; j++) {
      let t = 0;
      // X: 台本の文字を飛ばす（上から）
      {
        const o = prevM[j] + GAP_OPEN;
        const e = prevX[j] + GAP_EXT;
        const y = prevY[j] + GAP_OPEN;
        let v = o;
        let from = 0;
        if (e > v) {
          v = e;
          from = 1;
        }
        if (y > v) {
          v = y;
          from = 2;
        }
        curX[j] = v;
        t |= from << 2;
      }
      // Y: 聞き取りの文字を飛ばす（左から）
      if (j > 0) {
        const o = curM[j - 1] + GAP_OPEN;
        const e = curY[j - 1] + GAP_EXT;
        const x = curX[j - 1] + GAP_OPEN;
        let v = o;
        let from = 0;
        if (e > v) {
          v = e;
          from = 2;
        }
        if (x > v) {
          v = x;
          from = 1;
        }
        curY[j] = v;
        t |= from << 4;
      }
      // M: 対応させる（斜め）
      if (j > 0) {
        const s = ai === b[j - 1] ? MATCH : MISMATCH;
        const pm = prevM[j - 1];
        const px = prevX[j - 1];
        const py = prevY[j - 1];
        let v = pm;
        let from = 0;
        if (px > v) {
          v = px;
          from = 1;
        }
        if (py > v) {
          v = py;
          from = 2;
        }
        curM[j] = v + s;
        t |= from;
      }
      tb[base + j] = t;
    }
    [prevM, curM] = [curM, prevM];
    [prevX, curX] = [curX, prevX];
    [prevY, curY] = [curY, prevY];
  }
  // 終点
  let state = 0;
  let best = prevM[m];
  if (prevX[m] > best) {
    best = prevX[m];
    state = 1;
  }
  if (prevY[m] > best) state = 2;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const t = i >= 0 && j >= lo[i] && j <= hi[i] ? tb[rowOff[i] - lo[i] + j] : 0;
    if (i === 0) {
      inserted.push(j - 1);
      j--;
      continue;
    }
    if (j === 0) {
      i--;
      continue;
    }
    if (state === 0) {
      aToB[i - 1] = j - 1;
      if (a[i - 1] === b[j - 1]) exact[i - 1] = 1;
      state = t & 3;
      i--;
      j--;
    } else if (state === 1) {
      state = (t >> 2) & 3;
      i--;
    } else {
      inserted.push(j - 1);
      state = (t >> 4) & 3;
      j--;
    }
  }
  inserted.reverse();
  return { aToB, exact, inserted };
}
