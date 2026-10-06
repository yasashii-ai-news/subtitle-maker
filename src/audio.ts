// 動画・音声ファイルから、16kHz モノラルの音声を取り出す（ブラウザの中だけで行う）
import { SAMPLE_RATE } from './core/whisper.ts';

export async function decodeToMono16k(file: File): Promise<Float32Array> {
  const buf = await file.arrayBuffer();
  // OfflineAudioContext の sampleRate に合わせて、デコード時に 16kHz へ変換される
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } catch {
    throw new Error('この形式の音声を読み込めませんでした（mp4 / mov / wav / m4a / mp3 に対応しています）');
  }
  const n = decoded.length;
  const out = new Float32Array(n);
  const chs = decoded.numberOfChannels;
  for (let c = 0; c < chs; c++) {
    const d = decoded.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / chs;
  }
  return out;
}
