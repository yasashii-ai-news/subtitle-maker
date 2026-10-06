// 台本＋聞き取り結果 → 字幕（文字は台本から、時刻は聞き取りから）
import { align } from './align.ts';
import { type Envelope, refineOffset, refineOnset, speechRatio } from './energy.ts';
import { displayText, makeUnits, splitSentences } from './segment.ts';
import { normalizeWithMap } from './text.ts';
import type { AsrPiece, Cue, CueStatus, Settings } from './types.ts';

export const MIN_DUR = 0.8;
export const MAX_DUR = 7;
/** これより長い無音があれば、字幕を話し終わりで消す */
const HOLD_GAP = 0.8;
/** 話し終わりから消すまでの余韻 */
const TAIL = 0.25;

interface AsrChar {
  ch: string;
  t0: number;
  t1: number;
}

function asrChars(pieces: AsrPiece[]): { chars: AsrChar[]; raw: string } {
  const chars: AsrChar[] = [];
  let raw = '';
  for (const p of pieces) {
    const { chars: nc } = normalizeWithMap(p.text);
    const dur = Math.max(0, p.end - p.start);
    nc.forEach((ch, k) => {
      const t0 = p.start + (dur * k) / nc.length;
      const t1 = p.start + (dur * (k + 1)) / nc.length;
      chars.push({ ch, t0, t1 });
    });
    raw += p.text;
  }
  return { chars, raw };
}

export interface BuildResult {
  cues: Cue[];
  /** 一覧用：字幕にしない行（読まれていない文・台本にない発話）も含めたもの */
  rows: Cue[];
}

/**
 * 台本ありの字幕づくり。
 * duration は音声の長さ[秒]。
 */
export function buildFromScript(
  script: string,
  pieces: AsrPiece[],
  env: Envelope,
  duration: number,
  settings: Settings,
): BuildResult {
  const sentences = splitSentences(script);
  const units = makeUnits(script, sentences, settings);
  const sNorm = normalizeWithMap(script);
  const { chars: aChars } = asrChars(pieces);
  const res = align(
    sNorm.chars,
    aChars.map((c) => c.ch),
  );

  // 台本の各（正規化）文字の時刻。対応が無い文字は前後から補間する。
  const n = sNorm.chars.length;
  const t0 = new Float64Array(n).fill(NaN);
  const t1 = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const j = res.aToB[i];
    if (j >= 0) {
      t0[i] = aChars[j].t0;
      t1[i] = aChars[j].t1;
    }
  }
  interpolate(t0, t1, duration);

  // 台本の位置（コード単位）→ 正規化文字の範囲
  const firstNorm = (s: number, e: number) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sNorm.src[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    return lo < n && sNorm.src[lo] < e ? lo : -1;
  };
  const lastNorm = (s: number, e: number) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sNorm.src[mid] < e) lo = mid + 1;
      else hi = mid;
    }
    const k = lo - 1;
    return k >= 0 && sNorm.src[k] >= s ? k : -1;
  };

  // 文ごとに「読まれたか」を判定する
  const sentStatus: { status: CueStatus; note?: string }[] = sentences.map((sen) => {
    const a = firstNorm(sen.start, sen.end);
    const b = lastNorm(sen.start, sen.end);
    if (a < 0) return { status: 'ok' };
    let judged = 0;
    let hit = 0;
    let sub = 0;
    for (let i = a; i <= b; i++) {
      if (/[a-z]/.test(sNorm.chars[i])) continue; // 英字はカタカナで聞き取られるので判定に使わない
      judged++;
      if (res.exact[i]) hit++;
      else if (res.aToB[i] >= 0) sub++;
    }
    if (judged < 2) return { status: 'ok' };
    const ratio = hit / judged;
    if (ratio < 0.25 && (hit + sub) / judged < 0.6) return { status: 'unread', note: '読まれていない可能性（字幕にしません）' };
    if (ratio < 0.25) return { status: 'unread', note: '読まれていない可能性（字幕にしません）' };
    if (ratio < 0.6) return { status: 'mismatch', note: `台本と音声が違う可能性（一致 ${Math.round(ratio * 100)}%）` };
    return { status: 'ok' };
  });

  // 時刻の手がかりにするのは「完全一致した文字」だけ（読まれていない文の中の偶然の一致は使わない）
  const anchor = new Uint8Array(n);
  for (let i = 0; i < n; i++) anchor[i] = res.exact[i];
  sentences.forEach((sen, si) => {
    if (sentStatus[si].status !== 'unread') return;
    const a = firstNorm(sen.start, sen.end);
    const b = lastNorm(sen.start, sen.end);
    if (a >= 0) for (let i = a; i <= b; i++) anchor[i] = 0;
  });
  // 聞き取りの文字が無い所は、前後の時刻のあいだを台本の文字数で分ける
  const gapTime = (jp: number, jq: number, ratio: number) => {
    const tp = jp >= 0 ? aChars[jp].t1 : 0;
    const tq = jq < aChars.length ? aChars[jq].t0 : duration;
    return tp + Math.max(0, tq - tp) * ratio;
  };
  // 英字はカタカナ数文字ぶんくらいの長さで読まれる
  const weight = (i: number) => (/[a-z]/.test(sNorm.chars[i]) ? 0.6 : 1);
  const sumW = (from: number, to: number) => {
    let w = 0;
    for (let i = from; i < to; i++) w += weight(i);
    return w;
  };
  const prevAnchor = (i: number) => {
    while (i >= 0 && !anchor[i]) i--;
    return i;
  };
  const nextAnchor = (i: number) => {
    while (i < n && !anchor[i]) i++;
    return i;
  };
  /**
   * 台本の i 文字目から始まる字幕の開始時刻。
   * 前後の完全一致した文字のあいだにある聞き取りの文字を、台本の文字数の比で前後に分ける。
   */
  const boundaryStart = (i: number): number => {
    if (anchor[i]) return aChars[res.aToB[i]].t0;
    const p = prevAnchor(i - 1);
    const q = nextAnchor(i);
    const jp = p >= 0 ? res.aToB[p] : -1;
    const jq = q < n ? res.aToB[q] : aChars.length;
    const between = jq - jp - 1;
    const wTail = sumW(p + 1, i);
    const wHead = sumW(i, q);
    if (wTail + wHead <= 0) return jq < aChars.length ? aChars[jq].t0 : t0[i];
    if (between <= 0) return gapTime(jp, jq, wTail / (wTail + wHead));
    const k = Math.round((between * wTail) / (wTail + wHead));
    const j = jp + 1 + Math.min(k, between - 1);
    return aChars[j].t0;
  };
  const boundaryEnd = (i: number): number => {
    if (anchor[i]) return aChars[res.aToB[i]].t1;
    const p = prevAnchor(i);
    const q = nextAnchor(i + 1);
    const jp = p >= 0 ? res.aToB[p] : -1;
    const jq = q < n ? res.aToB[q] : aChars.length;
    const between = jq - jp - 1;
    const wTail = sumW(p + 1, i + 1);
    const wHead = sumW(i + 1, q);
    if (wTail + wHead <= 0) return jp >= 0 ? aChars[jp].t1 : t1[i];
    if (between <= 0) return gapTime(jp, jq, wTail / (wTail + wHead));
    const k = Math.round((between * wTail) / (wTail + wHead));
    if (k <= 0) return jp >= 0 ? aChars[jp].t1 : t1[i];
    return aChars[jp + Math.min(k, between)].t1;
  };

  // 「読まれていない」と出た文でも、その場所に文の長さぶんの声があるなら、聞き取りの失敗とみなして残す
  sentences.forEach((sen, si) => {
    if (sentStatus[si].status !== 'unread') return;
    const a = firstNorm(sen.start, sen.end);
    const b = lastNorm(sen.start, sen.end);
    if (a < 0) return;
    const p = prevAnchor(a - 1);
    const q = nextAnchor(b + 1);
    const tp = p >= 0 ? aChars[res.aToB[p]].t1 : 0;
    const tq = q < n ? aChars[res.aToB[q]].t0 : duration;
    const expected = sumW(a, b + 1) / 8; // 1秒に8文字くらい
    if (tq - tp >= Math.max(1.5, expected * 0.5) && speechRatio(env, tp, tq) >= 0.3) {
      sentStatus[si] = { status: 'mismatch', note: '音声を聞き取れなかった文（時刻は推定。要確認）' };
    }
  });

  // 台本にない発話（聞き取りにだけある、ひとまとまりの文字）
  const extras: Cue[] = [];
  {
    const ins = res.inserted;
    let k = 0;
    while (k < ins.length) {
      let e = k;
      while (e + 1 < ins.length && ins[e + 1] === ins[e] + 1) e++;
      const len = e - k + 1;
      const run = aChars.slice(ins[k], ins[e] + 1);
      const text = run.map((c) => c.ch).join('');
      // 英字・カタカナの言い換え（Claude Code→くろーどこーど）は除くため、ある程度長いものだけ
      if (len >= 6) {
        extras.push({
          id: 0,
          start: run[0].t0,
          end: run[run.length - 1].t1,
          text,
          status: 'extra',
          note: '台本にない発話（アドリブ・言い直しなど。字幕にしません）',
        });
      }
      k = e + 1;
    }
  }

  // 字幕1枚ずつの時刻
  const rows: Cue[] = [];
  const cues: Cue[] = [];
  for (const u of units) {
    const a = firstNorm(u.start, u.end);
    const b = lastNorm(u.start, u.end);
    const st = sentStatus[u.sentence];
    const text = displayText(u.lines, settings);
    let start = a >= 0 ? boundaryStart(a) : NaN;
    let end = b >= 0 ? boundaryEnd(b) : NaN;
    if (!Number.isFinite(start)) start = cues.length ? cues[cues.length - 1].end : 0;
    if (!Number.isFinite(end)) end = start + MIN_DUR;
    // その文の中で、照合が弱い（ずれている）部分だけを含む字幕にも印をつける
    let status: CueStatus = st.status;
    let note = st.note;
    if (status === 'ok' && a >= 0) {
      let judged = 0;
      let hit = 0;
      for (let i = a; i <= b; i++) {
        if (/[a-z]/.test(sNorm.chars[i])) continue;
        judged++;
        if (res.exact[i]) hit++;
      }
      if (judged >= 4 && hit / judged < 0.5) {
        status = 'mismatch';
        note = `台本と音声が違う可能性（一致 ${Math.round((hit / judged) * 100)}%）`;
      }
    }
    const cue: Cue = { id: 0, start, end, text, status, note };
    rows.push(cue);
    if (status !== 'unread') cues.push(cue);
  }
  finalizeTiming(cues, env, duration);
  // 読まれていない行の時刻は前後に合わせて表示だけする
  for (const r of rows) {
    if (r.status === 'unread') {
      const prev = [...rows.slice(0, rows.indexOf(r))].reverse().find((c) => c.status !== 'unread');
      r.start = r.end = prev ? prev.end : 0;
    }
  }
  const all = mergeRows(rows, extras);
  number(all, cues);
  return { cues, rows: all };
}

/** 台本なし：聞き取った文字で字幕を作る */
export function buildFromAsr(pieces: AsrPiece[], env: Envelope, duration: number, settings: Settings): BuildResult {
  // 間（0.5秒以上）があれば文の切れ目とみなす
  let script = '';
  for (let i = 0; i < pieces.length; i++) {
    if (i > 0 && pieces[i].start - pieces[i - 1].end >= 0.5 && !script.endsWith('\n')) script += '\n';
    script += pieces[i].text;
  }
  const r = buildFromScript(script, pieces, env, duration, settings);
  for (const c of r.rows) {
    if (c.status === 'ok' || c.status === 'mismatch') {
      c.status = 'asr';
      c.note = undefined;
    }
  }
  const rows = r.rows.filter((c) => c.status === 'asr');
  return { cues: rows, rows };
}

function interpolate(t0: Float64Array, t1: Float64Array, duration: number) {
  const n = t0.length;
  let i = 0;
  while (i < n) {
    if (Number.isFinite(t0[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !Number.isFinite(t0[j])) j++;
    const left = i > 0 ? t1[i - 1] : 0;
    const right = j < n ? t0[j] : duration;
    const span = Math.max(0, right - left);
    const cnt = j - i;
    for (let k = i; k < j; k++) {
      t0[k] = left + (span * (k - i)) / cnt;
      t1[k] = left + (span * (k - i + 1)) / cnt;
    }
    i = j;
  }
  // 時刻が逆戻りしないように
  for (let k = 1; k < n; k++) {
    if (t0[k] < t0[k - 1]) t0[k] = t0[k - 1];
    if (t1[k] < t0[k]) t1[k] = t0[k];
  }
}

/** 話し始め・話し終わりの微調整と、0.8〜7秒・重なりなしのルール */
export function finalizeTiming(cues: Cue[], env: Envelope | null, duration: number) {
  for (const c of cues) {
    if (env) c.start = refineOnset(env, c.start);
  }
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start < cues[i - 1].start + 0.05) cues[i].start = cues[i - 1].start + 0.05;
  }
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const next = cues[i + 1]?.start ?? duration;
    let end = Math.max(c.end, c.start);
    if (env) end = refineOffset(env, end, Math.min(next, end + 1.0));
    end = end + TAIL;
    if (next - end < HOLD_GAP) end = next; // 次までの間が短いなら出しっぱなし
    end = Math.min(end, next, c.start + MAX_DUR);
    if (end - c.start < MIN_DUR) end = c.start + MIN_DUR;
    c.end = end;
    // 短すぎて次と重なるなら、次の開始を後ろにずらす
    if (cues[i + 1] && cues[i + 1].start < c.end) cues[i + 1].start = c.end;
  }
  for (const c of cues) {
    c.start = round3(c.start);
    c.end = round3(c.end);
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function mergeRows(rows: Cue[], extras: Cue[]): Cue[] {
  const out = rows.slice();
  for (const x of extras) {
    let k = out.findIndex((r) => r.status !== 'unread' && r.start > x.start);
    if (k < 0) k = out.length;
    out.splice(k, 0, x);
  }
  return out;
}

function number(rows: Cue[], cues: Cue[]) {
  let id = 1;
  for (const r of rows) r.id = -1;
  for (const c of cues) c.id = id++;
}
