// Whisper をタイミング取得用に動かす（ブラウザの Worker と Node の検証スクリプトで共用）
import type { AsrPiece } from './types.ts';

export const SAMPLE_RATE = 16000;

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface WhisperParts {
  model: any;
  processor: any;
  tokenizer: any;
}

/**
 * 30秒以内の1区間を認識し、文字のかたまりごとの時刻を返す。
 * Japanese は単語の区切り（空白）が無いので、トークン単位の時刻（DTW）を自前で文字列に戻す。
 * 貪欲法・前の区間の文脈を使わないので、同じ入力なら必ず同じ結果になる。
 */
export async function transcribeChunk(
  parts: WhisperParts,
  audio: Float32Array,
  offset: number,
): Promise<AsrPiece[]> {
  const { model, processor, tokenizer } = parts;
  const { input_features } = await processor(audio);
  const out = await model.generate({
    inputs: input_features,
    language: 'ja',
    task: 'transcribe',
    return_timestamps: true,
    return_token_timestamps: true,
    num_frames: Math.floor(audio.length / 160),
    max_new_tokens: 440,
    do_sample: false,
    num_beams: 1,
  });
  const ids: bigint[] = out.sequences.tolist()[0];
  const ts: number[] = out.token_timestamps.tolist()[0];
  const tsBegin: number = tokenizer.timestamp_begin;
  const special = new Set<number>(tokenizer.all_special_ids);
  const audioEnd = audio.length / SAMPLE_RATE;

  const pieces: AsrPiece[] = [];
  let group: number[] = [];
  let groupIdx: number[] = [];
  const flush = (force: boolean) => {
    if (!group.length) return;
    const text: string = tokenizer.decode(group, { skip_special_tokens: true });
    if (!force && text.includes('�')) return; // UTF-8 の途中で切れている → 次のトークンとつなげる
    const first = groupIdx[0];
    const last = groupIdx[groupIdx.length - 1];
    const start = clampTime(ts[first], audioEnd);
    const end = clampTime(ts[last + 1] ?? ts[last], audioEnd);
    const clean = text.replace(/�/g, '');
    if (clean) pieces.push({ text: clean, start: offset + start, end: offset + Math.max(start, end) });
    group = [];
    groupIdx = [];
  };
  for (let i = 0; i < ids.length; i++) {
    const id = Number(ids[i]);
    if (id >= tsBegin || special.has(id)) {
      flush(true);
      continue;
    }
    group.push(id);
    groupIdx.push(i);
    flush(false);
  }
  flush(true);
  return removeRepeats(removeAnnotations(pieces));
}

/** 【音楽】(拍手) ♪ のような、話した言葉ではない注記を落とす */
function removeAnnotations(pieces: AsrPiece[]): AsrPiece[] {
  const out: AsrPiece[] = [];
  let depth = 0;
  for (const p of pieces) {
    let text = '';
    for (const ch of p.text) {
      if ('【[(（'.includes(ch)) depth++;
      else if ('】])）'.includes(ch)) depth = Math.max(0, depth - 1);
      else if (depth === 0 && ch !== '♪') text += ch;
    }
    if (text.trim()) out.push({ ...p, text });
  }
  return out;
}

function clampTime(t: number, max: number) {
  if (!Number.isFinite(t)) return 0;
  return Math.min(Math.max(t, 0), max);
}

/** Whisper がよく起こす「同じ言葉の繰り返し」（幻聴ループ）を落とす */
function removeRepeats(pieces: AsrPiece[]): AsrPiece[] {
  const text = pieces.map((p) => p.text).join('');
  for (let n = 2; n <= 12; n++) {
    const m = new RegExp(`(.{${n}})\\1{4,}$`, 'su').exec(text);
    if (m) {
      let keep = text.length - m[0].length + n;
      const out: AsrPiece[] = [];
      for (const p of pieces) {
        if (keep <= 0) break;
        out.push(p);
        keep -= p.text.length;
      }
      return out;
    }
  }
  return pieces;
}
