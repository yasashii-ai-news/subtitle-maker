// 台本を「文」→「字幕1枚」→「行」に分ける（文字は台本のまま。切る位置だけを決める）
import type { Settings } from './types.ts';
import {
  NO_LINE_END,
  NO_LINE_START,
  SENTENCE_END,
  charWidth,
  isDigit,
  isHiragana,
  isKanji,
  isKatakana,
  isLatinOrDigit,
} from './text.ts';

export interface Sentence {
  /** 台本全体の中の位置 [start, end) */
  start: number;
  end: number;
  paragraph: number;
}

export interface Unit {
  /** 台本全体の中の位置 [start, end)（前後の空白は除いたもの） */
  start: number;
  end: number;
  sentence: number;
  /** 表示する行（文字は台本の部分文字列そのまま） */
  lines: string[];
}

/** 台本を段落・文に分ける */
export function splitSentences(script: string): Sentence[] {
  const out: Sentence[] = [];
  let paragraph = 0;
  let start = -1;
  const push = (end: number) => {
    if (start < 0) return;
    let s = start;
    let e = end;
    while (s < e && /\s/u.test(script[s])) s++;
    while (e > s && /\s/u.test(script[e - 1])) e--;
    if (e > s) out.push({ start: s, end: e, paragraph });
    start = -1;
  };
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (ch === '\n') {
      push(i);
      // 空行（または改行）で段落が変わる
      if (out.length && out[out.length - 1].paragraph === paragraph) paragraph++;
      continue;
    }
    if (start < 0) {
      if (/\s/u.test(ch)) continue;
      start = i;
    }
    if (SENTENCE_END.has(ch)) {
      // 「。」のあとの閉じかっこ・連続する記号も同じ文に含める
      let j = i + 1;
      while (j < script.length && /[」』）)！？!?。]/u.test(script[j])) j++;
      push(j);
      i = j - 1;
    }
  }
  push(script.length);
  return out;
}

const PARTICLES = new Set([
  'は', 'が', 'を', 'に', 'で', 'と', 'も', 'へ', 'や', 'の', 'から', 'まで', 'より', 'けど', 'けれど',
  'ので', 'のに', 'ながら', 'には', 'では', 'とは', 'にも', 'でも', 'ても', 'て', 'って', 'ば', 'たら', 'し',
]);

const ONE_CHAR_PARTICLES = new Set('はがをにでともへやの'.split(''));

type Kind ='h' | 'k' | 'K' | 'L' | 'p' | 's' | 'o';
function kind(ch: string): Kind {
  if (isHiragana(ch)) return 'h';
  if (isKanji(ch)) return 'K';
  if (isKatakana(ch)) return 'k';
  if (isLatinOrDigit(ch)) return 'L';
  if (/\s/u.test(ch)) return 's';
  if (/[\p{P}\p{S}]/u.test(ch)) return 'p';
  return 'o';
}

/**
 * 文の中の各位置 i（chars[i-1] と chars[i] の間）で切るときのコスト。
 * 0 に近いほど意味の切れ目。Infinity は禁止（単語の途中・行頭禁則）。
 */
function breakCosts(chars: string[]): number[] {
  const n = chars.length;
  const cost = new Array<number>(n + 1).fill(25);
  cost[0] = Infinity;
  cost[n] = 0;
  // ICU の単語境界（ひらがなの並びの中で助詞のあとを見つけるのに使う）
  const icuEnds = new Map<number, string>();
  const text = chars.join('');
  const seg = new Intl.Segmenter('ja', { granularity: 'word' });
  const offsets: number[] = [];
  {
    let u = 0;
    for (const c of chars) {
      offsets.push(u);
      u += c.length;
    }
    offsets.push(u);
  }
  const toIndex = new Map<number, number>();
  offsets.forEach((u, i) => toIndex.set(u, i));
  for (const s of seg.segment(text)) {
    const endIdx = toIndex.get(s.index + s.segment.length);
    if (endIdx !== undefined) icuEnds.set(endIdx, s.segment);
  }

  for (let i = 1; i < n; i++) {
    const a = chars[i - 1];
    const b = chars[i];
    const ka = kind(a);
    const kb = kind(b);
    let c: number;
    if (a === '、' || a === '，' || a === ',') c = 0.5;
    else if (SENTENCE_END.has(a)) c = 0;
    else if (/[」』）)]/u.test(a)) c = 1;
    else if (ka === 's') {
      // 空白のあと：英単語どうしの間（Claude Code）は切らない
      const prev = chars[i - 2] ?? '';
      c = isLatinOrDigit(prev) && kb === 'L' ? 60 : 2;
    } else if (ka === 'h' && kb !== 'h' && kb !== 'p' && kb !== 's') {
      // ひらがな → 漢字/カタカナ/英字：文節の切れ目
      const word = icuEnds.get(i) ?? '';
      // 漢字＋送りがな1字＋漢字（書き|出す・取り|込む）は複合語なので切らない
      const okurigana = kind(chars[i - 2] ?? '') === 'K' && !ONE_CHAR_PARTICLES.has(a);
      c = okurigana ? 28 : word === 'の' ? 5 : 3;
    } else if (ka === 'h' && kb === 'h') {
      const word = icuEnds.get(i);
      c = word !== undefined && PARTICLES.has(word) ? 8 : word !== undefined ? 18 : 30;
    } else if (ka === 'K' && kb === 'K') c = icuEnds.has(i) ? 14 : 35;
    else if (ka === 'K' && kb === 'h') c = 45; // 送りがなの前
    else if (ka === 'k' && kb === 'k') c = Infinity; // カタカナ語の途中（カウント|アップ）
    else if (ka === 'L' && kb === 'L') c = Infinity; // 英単語・数字の途中
    else if (isDigit(a)) c = Infinity; // 12|個
    else if (ka === 'p' && kb !== 'p') c = 6;
    else c = 20; // 漢字→カタカナ、カタカナ→漢字など（複合語の可能性）
    if (NO_LINE_START.has(b) || NO_LINE_END.has(a) || kb === 's') c = Infinity;
    if (/[（(「『【]/u.test(b) && c !== Infinity) c = Math.min(c, 2);
    cost[i] = c;
  }
  return cost;
}

function widths(chars: string[]): number[] {
  const pre = [0];
  for (const c of chars) pre.push(pre[pre.length - 1] + charWidth(c));
  return pre;
}

/** 前後の空白を除いた幅 */
function spanWidth(pre: number[], chars: string[], a: number, b: number): number {
  while (a < b && /\s/u.test(chars[a])) a++;
  while (b > a && /\s/u.test(chars[b - 1])) b--;
  return pre[b] - pre[a];
}

interface LineSplit {
  cost: number;
  breaks: number[];
}

/** [a,b) を maxLines 行以内・各行 maxW 以内に分ける最善の方法 */
function bestLines(
  chars: string[],
  pre: number[],
  cost: number[],
  a: number,
  b: number,
  maxW: number,
  maxLines: number,
  relax: number,
): LineSplit | null {
  const total = spanWidth(pre, chars, a, b);
  if (total <= maxW) return { cost: 0, breaks: [] };
  if (maxLines <= 1) return null;
  let best: LineSplit | null = null;
  for (let k = a + 1; k < b; k++) {
    const bc = cost[k] === Infinity ? relax : cost[k];
    if (bc === Infinity) continue;
    const w1 = spanWidth(pre, chars, a, k);
    if (w1 > maxW) break;
    const rest = bestLines(chars, pre, cost, k, b, maxW, maxLines - 1, relax);
    if (!rest) continue;
    const w2 = spanWidth(pre, chars, k, b);
    // 意味の切れ目を優先し、そのうえで行の長さをそろえる（2行目が長いのは少しだけ嫌う）
    const balance = Math.abs(w1 - w2) * 0.25 + (w2 > w1 ? 0.5 : 0);
    const c = bc + balance + rest.cost;
    if (!best || c < best.cost) best = { cost: c, breaks: [k, ...rest.breaks] };
  }
  return best;
}

/** 1文を字幕の単位に分ける */
function splitSentence(chars: string[], s: Settings, relax: number): { ranges: [number, number][]; lines: number[][] } | null {
  const n = chars.length;
  const cost = breakCosts(chars);
  const pre = widths(chars);
  const maxW = s.maxCharsPerLine;
  const maxTotal = s.maxCharsPerLine * s.maxLines;
  const dp = new Array<number>(n + 1).fill(Infinity);
  const from = new Array<number>(n + 1).fill(-1);
  const linesAt: (number[] | null)[] = new Array(n + 1).fill(null);
  const lineMemo = new Map<string, LineSplit | null>();
  dp[0] = 0;
  for (let k = 1; k <= n; k++) {
    const bc = cost[k] === Infinity ? relax : cost[k];
    if (bc === Infinity) continue;
    for (let j = k - 1; j >= 0; j--) {
      if (dp[j] === Infinity) continue;
      const w = spanWidth(pre, chars, j, k);
      if (w > maxTotal) break;
      if (w === 0) continue;
      const key = `${j},${k}`;
      let ls = lineMemo.get(key);
      if (ls === undefined) {
        ls = bestLines(chars, pre, cost, j, k, maxW, s.maxLines, relax);
        lineMemo.set(key, ls);
      }
      if (!ls) continue;
      // 1枚ごとの基本コスト（少ない枚数を好む）＋短すぎる字幕は避ける
      const short = w < 5 ? 25 : w < 8 ? 6 : 0;
      const c = dp[j] + (bc <= 1 ? bc : bc * 4 + 4) + 6 + short + ls.cost; // 字幕の切れ目は句読点を強く好む
      if (c < dp[k]) {
        dp[k] = c;
        from[k] = j;
        linesAt[k] = ls.breaks;
      }
    }
  }
  if (dp[n] === Infinity) return null;
  const ranges: [number, number][] = [];
  const lines: number[][] = [];
  for (let k = n; k > 0; k = from[k]) {
    ranges.unshift([from[k], k]);
    lines.unshift(linesAt[k]!);
  }
  return { ranges, lines };
}

/** 台本全体 → 字幕の単位 */
export function makeUnits(script: string, sentences: Sentence[], settings: Settings): Unit[] {
  const units: Unit[] = [];
  sentences.forEach((sen, si) => {
    const chars = Array.from(script.slice(sen.start, sen.end));
    // コード単位の位置 ↔ 文字の位置
    const off: number[] = [];
    let u = sen.start;
    for (const c of chars) {
      off.push(u);
      u += c.length;
    }
    off.push(u);
    const r = splitSentence(chars, settings, Infinity) ?? splitSentence(chars, settings, 200)!;
    r.ranges.forEach(([a, b], idx) => {
      const cut = [a, ...r.lines[idx], b];
      const lines: string[] = [];
      for (let i = 0; i + 1 < cut.length; i++) {
        const line = chars.slice(cut[i], cut[i + 1]).join('').trim();
        if (line) lines.push(line);
      }
      let s = a;
      let e = b;
      while (s < e && /\s/u.test(chars[s])) s++;
      while (e > s && /\s/u.test(chars[e - 1])) e--;
      units.push({ start: off[s], end: off[e], sentence: si, lines });
    });
  });
  return units;
}

/** 表示用の文字（設定で文末の「。」を消す） */
export function displayText(lines: string[], settings: Settings): string {
  const ls = lines.slice();
  if (settings.removeFinalPeriod && ls.length) {
    const last = ls[ls.length - 1].replace(/[。．]+$/u, '');
    if (last) ls[ls.length - 1] = last;
    else ls.pop();
  }
  return ls.join('\n');
}
