// 書き出し（SRT / VTT / テキスト）
import type { Cue } from './types.ts';

function ts(sec: number, sep: string): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (x: number, n = 2) => String(x).padStart(n, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`;
}

/** SRT（番号・時刻・本文・空行。改行は CRLF で、多くの編集ソフトが読める形） */
export function toSrt(cues: Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\r\n${ts(c.start, ',')} --> ${ts(c.end, ',')}\r\n${c.text.replace(/\n/g, '\r\n')}\r\n`)
    .join('\r\n');
}

export function toVtt(cues: Cue[]): string {
  return (
    'WEBVTT\n\n' +
    cues.map((c, i) => `${i + 1}\n${ts(c.start, '.')} --> ${ts(c.end, '.')}\n${c.text}\n`).join('\n')
  );
}

/** テキスト：字幕1枚を1行で */
export function toText(cues: Cue[]): string {
  return cues.map((c) => c.text.replace(/\n/g, '')).join('\n') + '\n';
}
