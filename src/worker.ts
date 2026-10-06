// 音声認識の Worker（重い処理はここで。画面は固まらない）
import {
  AutoProcessor,
  AutoTokenizer,
  WhisperForConditionalGeneration,
  env,
} from '@huggingface/transformers';
// ONNX Runtime の WASM は CDN から取らず、アプリと一緒に配る（外へ出る通信をモデルのダウンロードだけにする）
import ortWasmUrl from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import ortMjsUrl from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';
import { transcribeChunk, SAMPLE_RATE, type WhisperParts } from './core/whisper.ts';
import type { AsrPiece } from './core/types.ts';

env.allowLocalModels = false; // モデルは Hugging Face から（初回のみ。以降はブラウザのキャッシュ）
env.useBrowserCache = true;
const onnxEnv = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } };
if (onnxEnv.wasm) {
  onnxEnv.wasm.wasmPaths = {
    wasm: new URL(ortWasmUrl, self.location.href).href,
    mjs: new URL(ortMjsUrl, self.location.href).href,
  };
}

export type WorkerIn = {
  type: 'run';
  model: string;
  audio: Float32Array;
  chunks: { start: number; end: number }[];
};

export type WorkerOut =
  | { type: 'status'; text: string }
  | { type: 'download'; file: string; loaded: number; total: number }
  | { type: 'loaded'; device: string; ms: number }
  | { type: 'chunk'; done: number; total: number; pieces: AsrPiece[] }
  | { type: 'done'; pieces: AsrPiece[]; ms: number; device: string }
  | { type: 'error'; message: string };

const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m);

let loaded: { key: string; parts: WhisperParts; device: string } | null = null;

async function pickDevice(): Promise<{ device: 'webgpu' | 'wasm'; f16: boolean }> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
  if (!gpu) return { device: 'wasm', f16: false };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { device: 'wasm', f16: false };
    return { device: 'webgpu', f16: adapter.features.has('shader-f16') };
  } catch {
    return { device: 'wasm', f16: false };
  }
}

async function load(model: string): Promise<{ parts: WhisperParts; device: string }> {
  const { device, f16 } = await pickDevice();
  const key = `${model}|${device}`;
  if (loaded?.key === key) return loaded;
  const t0 = performance.now();
  post({ type: 'status', text: `モデルを準備しています（${device === 'webgpu' ? 'WebGPU' : 'WASM'}）` });
  const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status === 'progress' && p.file) post({ type: 'download', file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 });
  };
  const enc = device === 'webgpu' ? (f16 ? 'fp16' : 'fp32') : 'q8';
  const dec = device === 'webgpu' ? (f16 ? 'q4f16' : 'q4') : 'q8';
  // "model" も同じ値にする：Transformers.js がファイルの大きさを確かめるときはこの名前で引くため、
  // 無いと2回目以降も使わないファイル（encoder_model.onnx）へ問い合わせてしまう
  const dtype = { model: enc, encoder_model: enc, decoder_model_merged: dec };
  const [processor, tokenizer, m] = await Promise.all([
    AutoProcessor.from_pretrained(model, { progress_callback }),
    AutoTokenizer.from_pretrained(model, { progress_callback }),
    WhisperForConditionalGeneration.from_pretrained(model, {
      device,
      dtype: dtype as never,
      progress_callback,
    }),
  ]);
  loaded = { key, parts: { processor, tokenizer, model: m }, device };
  post({ type: 'loaded', device, ms: performance.now() - t0 });
  return loaded;
}

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type !== 'run') return;
  try {
    const { parts, device } = await load(msg.model);
    const t0 = performance.now();
    const all: AsrPiece[] = [];
    post({ type: 'chunk', done: 0, total: msg.chunks.length, pieces: [] });
    for (let i = 0; i < msg.chunks.length; i++) {
      const c = msg.chunks[i];
      const seg = msg.audio.subarray(Math.round(c.start * SAMPLE_RATE), Math.round(c.end * SAMPLE_RATE));
      const pieces = await transcribeChunk(parts, seg, c.start);
      all.push(...pieces);
      post({ type: 'chunk', done: i + 1, total: msg.chunks.length, pieces });
    }
    post({ type: 'done', pieces: all, ms: performance.now() - t0, device });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
