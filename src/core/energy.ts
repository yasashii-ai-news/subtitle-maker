// 音量の包絡線を使った処理（区間の切り分け・話し始め/話し終わりの微調整）
import { SAMPLE_RATE } from './whisper.ts';

export const FRAME = 0.01; // 10ms ごと

export interface Envelope {
  /** 各フレームの音量 [dB]（20ms 窓） */
  db: Float32Array;
  /** 話し声の大きさの目安（上位10%の音量） */
  speechLevel: number;
}

export function computeEnvelope(audio: Float32Array): Envelope {
  const hop = Math.round(SAMPLE_RATE * FRAME);
  const win = hop * 2;
  const n = Math.max(1, Math.floor(audio.length / hop));
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let e = 0;
    const s = i * hop;
    const end = Math.min(audio.length, s + win);
    for (let j = s; j < end; j++) e += audio[j] * audio[j];
    db[i] = 10 * Math.log10(e / Math.max(1, end - s) + 1e-10);
  }
  const sorted = Array.from(db).sort((a, b) => a - b);
  const speechLevel = sorted[Math.floor(sorted.length * 0.9)] ?? -20;
  return { db, speechLevel };
}

function smooth(db: Float32Array, from: number, to: number, radius: number): number {
  let s = 0;
  let c = 0;
  for (let i = Math.max(0, from - radius); i <= Math.min(db.length - 1, to + radius); i++) {
    s += db[i];
    c++;
  }
  return c ? s / c : -100;
}

/**
 * Whisper に渡す区間（30秒以内）を、なるべく静かな所で切って作る。
 * 無音だけの区間は飛ばす（無音で Whisper が文字を作ってしまうのを防ぐ）。
 */
export function planChunks(env: Envelope, maxLen = 28, minLen = 14): { start: number; end: number }[] {
  const total = env.db.length * FRAME;
  const chunks: { start: number; end: number }[] = [];
  let start = 0;
  while (start < total - 0.05) {
    let end: number;
    if (total - start <= maxLen) {
      end = total;
    } else {
      // [start+minLen, start+maxLen] の中で、0.3秒平均がいちばん静かな所
      let best = -1;
      let bestVal = Infinity;
      const a = Math.round((start + minLen) / FRAME);
      const b = Math.round((start + maxLen) / FRAME);
      for (let i = a; i <= b; i++) {
        // 少しだけ後ろ寄りを好む（区間を長めに取る）
        const v = smooth(env.db, i, i, 15) - (i - a) * 0.002;
        if (v < bestVal) {
          bestVal = v;
          best = i;
        }
      }
      end = best * FRAME;
    }
    const s = Math.round(start / FRAME);
    const e = Math.min(env.db.length, Math.round(end / FRAME));
    let max = -100;
    for (let i = s; i < e; i++) max = Math.max(max, smooth(env.db, i, i, 5));
    if (max > env.speechLevel - 25) chunks.push({ start, end });
    start = end;
  }
  return chunks;
}

/** t のまわり ±3秒の静かな部分（BGM・環境音）の大きさ */
function localFloor(env: Envelope, t: number): number {
  const c = Math.round(t / FRAME);
  const a = Math.max(0, c - 300);
  const b = Math.min(env.db.length, c + 300);
  const v = Array.from(env.db.subarray(a, b)).sort((x, y) => x - y);
  return v[Math.floor(v.length * 0.15)] ?? -60;
}

/**
 * Whisper の時刻 t（少し遅れがち）の直前に「間」があれば、間が終わって声が立ち上がる瞬間に合わせる。
 * 近くに間が無ければ（話の途中なら）t をそのまま返す。
 */
export function refineOnset(env: Envelope, t: number, lo = 0.5, hi = 0.2): number {
  const db = env.db;
  const quiet = Math.min(env.speechLevel - 10, localFloor(env, t) + 6);
  const loud = env.speechLevel - 10;
  const a = Math.max(0, Math.round((t - lo) / FRAME));
  const b = Math.min(db.length - 1, Math.round((t + hi) / FRAME));
  const lvl = (i: number) => smooth(db, i, i, 1);
  // a..b の中でいちばん長い「静かな連続（60ms以上）」の終わり（促音「っ」の短い無音と区別する）
  let onset = -1;
  let bestRun = 5;
  let run = 0;
  for (let i = a; i <= b + 1; i++) {
    if (i <= b && lvl(i) < quiet) run++;
    else {
      if (run >= bestRun) {
        bestRun = run;
        onset = i;
      }
      run = 0;
    }
  }
  if (onset < 0) return t;
  // 間のあと 0.25 秒以内に、はっきり声になっているか
  let ok = false;
  for (let i = onset; i < Math.min(db.length, onset + 25); i++) {
    if (lvl(i) >= loud) {
      ok = true;
      break;
    }
  }
  return ok ? onset * FRAME : t;
}

/** t から先で、声が途切れる（間に入る）時刻を探す。見つからなければ t。 */
export function refineOffset(env: Envelope, t: number, limit: number): number {
  const db = env.db;
  const s = Math.round(t / FRAME);
  const e = Math.min(db.length - 1, Math.round(limit / FRAME));
  const quiet = env.speechLevel - 18;
  for (let i = s; i <= e; i++) {
    let allQuiet = true;
    for (let j = i; j < Math.min(db.length, i + 15); j++) {
      if (db[j] > quiet) {
        allQuiet = false;
        break;
      }
    }
    if (allQuiet) return i * FRAME;
  }
  return Math.max(t, Math.min(limit, t));
}

/**
 * 1回目の聞き取りで文字が出なかったのに声がある所（Whisper の読み飛ばし）を探す。
 * ここだけをもう一度聞き取ると、区間の切れ目で落ちた文が戻ってくる。
 */
export function findUncovered(
  env: Envelope,
  pieces: { start: number; end: number }[],
  minLen = 1.2,
): { start: number; end: number }[] {
  const n = env.db.length;
  const covered = new Uint8Array(n);
  for (const p of pieces) {
    const a = Math.max(0, Math.round((p.start - 0.15) / FRAME));
    const b = Math.min(n, Math.round((p.end + 0.15) / FRAME));
    covered.fill(1, a, b);
  }
  const loud = env.speechLevel - 12;
  const out: { start: number; end: number }[] = [];
  let i = 0;
  while (i < n) {
    if (covered[i]) {
      i++;
      continue;
    }
    let j = i;
    let speech = 0;
    while (j < n && !covered[j]) {
      if (env.db[j] > loud) speech++;
      j++;
    }
    const len = (j - i) * FRAME;
    if (len >= minLen && speech * FRAME >= Math.max(0.6, len * 0.3)) {
      // 30秒を超えないように分ける
      for (let s = i * FRAME; s < j * FRAME - 0.3; s += 28) {
        out.push({ start: Math.max(0, s - 0.2), end: Math.min(n * FRAME, Math.min(j * FRAME, s + 28) + 0.2) });
      }
    }
    i = j;
  }
  return out;
}

/** 2回目の聞き取り結果を1回目に差し込む（すでに文字がある時間と重なるものは捨てる） */
export function mergeRetry<T extends { start: number; end: number }>(
  first: T[],
  retry: T[],
  regions: { start: number; end: number }[],
): T[] {
  const extra = retry.filter((p) => {
    if (!regions.some((r) => p.start >= r.start && p.start < r.end)) return false;
    return !first.some((q) => p.start < q.end - 0.05 && q.start < p.end - 0.05);
  });
  return [...first, ...extra].sort((a, b) => a.start - b.start);
}

/** [t0, t1) のうち、声らしい大きさのフレームの割合 */
export function speechRatio(env: Envelope, t0: number, t1: number): number {
  const a = Math.max(0, Math.round(t0 / FRAME));
  const b = Math.min(env.db.length, Math.round(t1 / FRAME));
  if (b <= a) return 0;
  let c = 0;
  for (let i = a; i < b; i++) if (env.db[i] > env.speechLevel - 12) c++;
  return c / (b - a);
}
