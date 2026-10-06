import './style.css';
import { decodeToMono16k } from './audio.ts';
import { buildFromAsr, buildFromScript, MAX_DUR, MIN_DUR } from './core/build.ts';
import { computeEnvelope, findUncovered, mergeRetry, planChunks, type Envelope } from './core/energy.ts';
import { toSrt, toText, toVtt } from './core/formats.ts';
import { textWidth } from './core/text.ts';
import type { AsrPiece, Cue, Settings } from './core/types.ts';
import { SAMPLE_RATE } from './core/whisper.ts';
import type { WorkerIn, WorkerOut } from './worker.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>('file');
const drop = $<HTMLLabelElement>('drop');
const filenameEl = $('filename');
const scriptEl = $<HTMLTextAreaElement>('script');
const runBtn = $<HTMLButtonElement>('run');
const progressBox = $('progressBox');
const bar = $('bar');
const statusEl = $('status');
const video = $<HTMLVideoElement>('video');
const overlay = $('overlay');
const rowsEl = $('rows');
const summaryEl = $('summary');
const modelSel = $<HTMLSelectElement>('model');

// ---- 状態 ----
let file: File | null = null;
let videoUrl = '';
let audio: { key: string; data: Float32Array; env: Envelope } | null = null;
const asrCache = new Map<string, AsrPiece[]>();
/** 一覧の行（字幕にしない行も含む） */
let rows: Cue[] = [];
let busy = false;
let worker: Worker | null = null;

const exportable = (c: Cue) => c.status !== 'unread' && c.status !== 'extra';
const cues = () => rows.filter(exportable);

function settings(): Settings {
  const clamp = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    maxCharsPerLine: clamp(Number($<HTMLInputElement>('maxChars').value), 6, 40, 16),
    maxLines: clamp(Math.round(Number($<HTMLInputElement>('maxLines').value)), 1, 3, 2),
    removeFinalPeriod: $<HTMLInputElement>('removePeriod').checked,
  };
}

// ---- ファイル ----
function setFile(f: File) {
  file = f;
  filenameEl.textContent = `${f.name}（${(f.size / 1e6).toFixed(1)} MB）`;
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(f);
  video.src = videoUrl;
  audio = null;
  runBtn.disabled = false;
}
fileInput.addEventListener('change', () => fileInput.files?.[0] && setFile(fileInput.files[0]));
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) setFile(f);
});

// ---- 進み具合 ----
function showProgress(ratio: number | null, text: string) {
  progressBox.hidden = false;
  bar.style.width = ratio === null ? '100%' : `${Math.round(ratio * 1000) / 10}%`;
  bar.classList.toggle('indeterminate', ratio === null);
  statusEl.textContent = text;
}

const fmtMin = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}分${Math.round(sec % 60)}秒` : `${Math.round(sec)}秒`);

function runWorker(model: string, data: Float32Array, chunks: { start: number; end: number }[], label: string): Promise<AsrPiece[]> {
  if (!worker) worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  const total = chunks.reduce((s, c) => s + (c.end - c.start), 0);
  const downloads = new Map<string, { loaded: number; total: number }>();
  let t0 = 0;
  return new Promise((resolve, reject) => {
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === 'status') showProgress(null, m.text);
      else if (m.type === 'download') {
        downloads.set(m.file, { loaded: m.loaded, total: m.total });
        let l = 0;
        let t = 0;
        for (const d of downloads.values()) {
          l += d.loaded;
          t += d.total;
        }
        showProgress(t ? l / t : null, `モデルをダウンロード中（初回だけ）… ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB`);
      } else if (m.type === 'loaded') {
        showProgress(0, `モデルの準備ができました（${m.device === 'webgpu' ? 'WebGPU' : 'WASM'}）。聞き取りを始めます…`);
      } else if (m.type === 'chunk') {
        if (m.done === 0) t0 = performance.now();
        const doneSec = chunks.slice(0, m.done).reduce((s, c) => s + (c.end - c.start), 0);
        const el = (performance.now() - t0) / 1000;
        const eta = m.done ? (el / doneSec) * (total - doneSec) : NaN;
        showProgress(
          m.done / m.total,
          `${label} ${m.done}/${m.total}（${fmtMin(doneSec)} / ${fmtMin(total)}）` + (Number.isFinite(eta) ? ` 残り約${fmtMin(eta)}` : ''),
        );
      } else if (m.type === 'done') {
        console.info(`[asr] ${m.device} ${(m.ms / 1000).toFixed(1)}s for ${total.toFixed(1)}s audio`);
        resolve(m.pieces);
      } else if (m.type === 'error') reject(new Error(m.message));
    };
    w.onerror = (e) => reject(new Error(e.message || 'Worker でエラーが起きました'));
    const msg: WorkerIn = { type: 'run', model, audio: data, chunks };
    w.postMessage(msg);
  });
}

async function generate() {
  if (!file || busy) return;
  busy = true;
  runBtn.disabled = true;
  const started = performance.now();
  try {
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (audio?.key !== key) {
      showProgress(null, '音声を取り出しています…');
      const data = await decodeToMono16k(file);
      audio = { key, data, env: computeEnvelope(data) };
    }
    const duration = audio.data.length / SAMPLE_RATE;
    const model = modelSel.value;
    const asrKey = `${key}|${model}`;
    let pieces = asrCache.get(asrKey);
    if (!pieces) {
      const chunks = planChunks(audio.env);
      // Worker に渡すのはコピー（元の音声は作り直しのために残す）
      pieces = await runWorker(model, audio.data.slice(), chunks, '聞き取り中');
      // 声があるのに文字が出なかった所（Whisper の読み飛ばし）だけ、もう一度聞き取る
      const retry = findUncovered(audio.env, pieces);
      if (retry.length) {
        const more = await runWorker(model, audio.data.slice(), retry, '読み飛ばしを聞き直し中');
        pieces = mergeRetry(pieces, more, retry);
      }
      asrCache.set(asrKey, pieces);
    }
    showProgress(1, '台本と照らし合わせています…');
    await new Promise((r) => setTimeout(r, 0));
    const script = scriptEl.value.trim();
    const s = settings();
    const r = script ? buildFromScript(script, pieces, audio.env, duration, s) : buildFromAsr(pieces, audio.env, duration, s);
    rows = r.rows;
    render();
    const n = cues().length;
    const unread = rows.filter((c) => c.status === 'unread').length;
    showProgress(1, `できました：字幕 ${n} 枚（${fmtMin((performance.now() - started) / 1000)}）` + (unread ? `・読まれていない文 ${unread}` : ''));
  } catch (err) {
    console.error(err);
    showProgress(0, `エラー：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    busy = false;
    runBtn.disabled = !file;
  }
}
runBtn.addEventListener('click', generate);

// ---- 一覧 ----
function fmtTime(t: number) {
  const cs = Math.round(t * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const r = cs % 100;
  const p = (x: number) => String(x).padStart(2, '0');
  return `${h ? h + ':' : ''}${p(m)}:${p(s)}.${p(r)}`;
}

function problems(c: Cue, idx: number, list: Cue[]): string[] {
  if (!exportable(c)) return [];
  const s = settings();
  const out: string[] = [];
  const lines = c.text.split('\n');
  if (lines.length > s.maxLines) out.push(`${s.maxLines}行を超えています`);
  if (lines.some((l) => textWidth(l) > s.maxCharsPerLine)) out.push(`1行${s.maxCharsPerLine}字を超えています`);
  const d = c.end - c.start;
  if (d < MIN_DUR - 1e-6) out.push(`表示が${MIN_DUR}秒より短い`);
  if (d > MAX_DUR + 1e-6) out.push(`表示が${MAX_DUR}秒より長い`);
  const next = list[idx + 1];
  if (next && c.end > next.start + 1e-6) out.push('次の字幕と重なっています');
  return out;
}

function render() {
  const list = cues();
  rowsEl.textContent = '';
  if (!rows.length) {
    rowsEl.innerHTML = '<p class="empty">字幕がありません。</p>';
  }
  const frag = document.createDocumentFragment();
  rows.forEach((c) => frag.appendChild(renderRow(c, list)));
  rowsEl.appendChild(frag);
  const warn = rows.filter((c) => c.status !== 'ok' && c.status !== 'asr').length;
  summaryEl.textContent = rows.length ? `${list.length} 枚` + (warn ? ` ・ 要確認 ${warn}` : '') : '';
  for (const id of ['exSrt', 'exVtt', 'exTxt']) $<HTMLButtonElement>(id).disabled = !list.length;
  updateOverlay();
}

function renderRow(c: Cue, list: Cue[]): HTMLElement {
  const el = document.createElement('div');
  el.className = `row st-${c.status}`;
  const idx = list.indexOf(c);
  const no = idx >= 0 ? String(idx + 1) : '—';
  const issue = problems(c, idx, list);
  el.innerHTML = `
    <div class="no">${no}</div>
    <div class="times">
      <div class="t"><button data-act="s-" title="開始を0.1秒早く">−</button><span>${fmtTime(c.start)}</span><button data-act="s+" title="開始を0.1秒遅く">＋</button></div>
      <div class="t"><button data-act="e-" title="終了を0.1秒早く">−</button><span>${fmtTime(c.end)}</span><button data-act="e+" title="終了を0.1秒遅く">＋</button></div>
    </div>
    <div class="body">
      <textarea rows="2" spellcheck="false"></textarea>
      <div class="note"></div>
    </div>
    <div class="ops">
      <button data-act="split" title="カーソルの位置（なければ改行の位置）で2枚に分ける">分割</button>
      <button data-act="merge" title="次の字幕とつなげる">結合↓</button>
    </div>`;
  const ta = el.querySelector('textarea')!;
  ta.value = c.text;
  ta.readOnly = !exportable(c);
  const note = el.querySelector('.note')!;
  note.textContent = [c.note, ...issue].filter(Boolean).join(' / ');
  if (issue.length) el.classList.add('has-issue');
  if (!exportable(c)) el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true));

  ta.addEventListener('input', () => {
    c.text = ta.value.replace(/\r/g, '');
    const list2 = cues();
    const iss = problems(c, list2.indexOf(c), list2);
    note.textContent = [c.note, ...iss].filter(Boolean).join(' / ');
    el.classList.toggle('has-issue', iss.length > 0);
    updateOverlay();
  });
  ta.addEventListener('focus', () => seek(c.start, false));
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const btn = t.closest('button');
    if (btn) {
      e.stopPropagation();
      act(c, btn.dataset.act!, ta);
      return;
    }
    if (t.tagName === 'TEXTAREA') return;
    seek(c.start, true);
  });
  return el;
}

function seek(t: number, play: boolean) {
  if (!video.src) return;
  video.currentTime = t + 0.001;
  if (play) void video.play().catch(() => {});
  updateOverlay();
}

function act(c: Cue, a: string, ta: HTMLTextAreaElement) {
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const list = cues();
  const i = list.indexOf(c);
  if (a === 's-') c.start = r3(Math.max(0, c.start - 0.1));
  else if (a === 's+') c.start = r3(Math.min(c.end - 0.1, c.start + 0.1));
  else if (a === 'e-') c.end = r3(Math.max(c.start + 0.1, c.end - 0.1));
  else if (a === 'e+') c.end = r3(c.end + 0.1);
  else if (a === 'split') {
    const text = c.text;
    let pos = document.activeElement === ta ? ta.selectionStart : -1;
    if (pos <= 0 || pos >= text.length) pos = text.indexOf('\n');
    if (pos <= 0) pos = Math.floor(text.length / 2);
    const a1 = text.slice(0, pos).replace(/\n+$/u, '');
    const b1 = text.slice(pos).replace(/^\n+/u, '');
    if (!a1 || !b1) return;
    const ratio = a1.length / (a1.length + b1.length);
    const mid = r3(c.start + (c.end - c.start) * ratio);
    const second: Cue = { ...c, id: 0, start: mid, text: b1 };
    c.text = a1;
    c.end = mid;
    rows.splice(rows.indexOf(c) + 1, 0, second);
  } else if (a === 'merge') {
    const next = list[i + 1];
    if (!next) return;
    c.text = `${c.text.replace(/\n/g, '')}\n${next.text.replace(/\n/g, '')}`;
    c.end = next.end;
    if (next.status !== 'ok' && c.status === 'ok') {
      c.status = next.status;
      c.note = next.note;
    }
    rows.splice(rows.indexOf(next), 1);
  }
  render();
  if (a.startsWith('s')) seek(c.start, true);
}

// ---- プレビュー（字幕を重ねる） ----
let lastText = '';
function updateOverlay() {
  const t = video.currentTime;
  const c = cues().find((x) => t >= x.start && t < x.end);
  const text = c ? c.text : '';
  if (text !== lastText) {
    overlay.textContent = '';
    for (const line of text.split('\n')) {
      if (!line) continue;
      const span = document.createElement('span');
      span.textContent = line;
      overlay.appendChild(span);
    }
    lastText = text;
  }
  rowsEl.querySelectorAll('.row.active').forEach((r) => r.classList.remove('active'));
  if (c) {
    const idx = rows.indexOf(c);
    rowsEl.children[idx]?.classList.add('active');
  }
}
const tick = () => {
  updateOverlay();
  if (!video.paused) requestAnimationFrame(tick);
};
video.addEventListener('play', () => requestAnimationFrame(tick));
video.addEventListener('seeked', updateOverlay);
video.addEventListener('timeupdate', updateOverlay);

// ---- 書き出し ----
function baseName() {
  return (file?.name ?? 'subtitle').replace(/\.[^.]+$/u, '');
}
function download(text: string, ext: string, mime: string) {
  const blob = new Blob(ext === 'srt' ? ['﻿', text] : [text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${baseName()}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
$('exSrt').addEventListener('click', () => download(toSrt(cues()), 'srt', 'application/x-subrip;charset=utf-8'));
$('exVtt').addEventListener('click', () => download(toVtt(cues()), 'vtt', 'text/vtt;charset=utf-8'));
$('exTxt').addEventListener('click', () => download(toText(cues()), 'txt', 'text/plain;charset=utf-8'));

// モデルをブラウザに保存したまま消されにくくする
void navigator.storage?.persist?.().catch(() => {});

// 自動テスト用に状態を読めるようにしておく（外部には何も送らない）
(window as unknown as { __subtitle: unknown }).__subtitle = {
  rows: () => rows,
  srt: () => toSrt(cues()),
  vtt: () => toVtt(cues()),
  text: () => toText(cues()),
  busy: () => busy,
  pieces: () => [...asrCache.values()].at(-1) ?? [],
};
