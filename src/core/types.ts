/** 音声認識の結果（文字のかたまりと、その発話時刻[秒]） */
export interface AsrPiece {
  text: string;
  start: number;
  end: number;
}

/** 台本と音声の照合の状態 */
export type CueStatus =
  | 'ok' // 台本どおり
  | 'mismatch' // 読み違い・言い直しなど、台本と音声に違いがある
  | 'unread' // 読まれていない（字幕にしない）
  | 'extra' // 台本にない発話（アドリブなど。字幕にしない）
  | 'asr'; // 台本なしモード（聞き取りの文字）

export interface Cue {
  id: number;
  start: number;
  end: number;
  /** 表示する文字（改行 \n 込み） */
  text: string;
  status: CueStatus;
  /** 一覧に出す補足（ずれの理由・聞き取った文字など） */
  note?: string;
}

export interface Settings {
  maxCharsPerLine: number;
  maxLines: number;
  removeFinalPeriod: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  maxCharsPerLine: 16,
  maxLines: 2,
  removeFinalPeriod: true,
};
