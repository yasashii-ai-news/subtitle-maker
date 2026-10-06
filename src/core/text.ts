// 文字の種類・幅・照合用の正規化

/** 全角換算の幅（半角英数・半角カナは 0.5） */
export function charWidth(ch: string): number {
  const c = ch.codePointAt(0)!;
  if (c < 0x7f) return 0.5;
  if (c >= 0xff61 && c <= 0xff9f) return 0.5;
  return 1;
}

export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

export const isHiragana = (ch: string) => /^[ぁ-ゟ]$/u.test(ch);
export const isKatakana = (ch: string) => /^[゠-ヿｦ-ﾟ]$/u.test(ch);
export const isKanji = (ch: string) => /^[㐀-鿿豈-﫿々〆ヶ]$/u.test(ch);
export const isLatinOrDigit = (ch: string) => /^[A-Za-z0-9Ａ-Ｚａ-ｚ０-９]$/u.test(ch);
export const isDigit = (ch: string) => /^[0-9０-９]$/u.test(ch);

/** 行頭に置いてはいけない文字 */
export const NO_LINE_START = new Set(
  '、。，．,.！？!?）)」』】〕〉》］]｝}ー〜～・：:；;ゃゅょっぁぃぅぇぉゎャュョッァィゥェォヮヵヶ％%'.split(''),
);
/** 行末に置いてはいけない文字 */
export const NO_LINE_END = new Set('（(「『【〔〈《［[｛{'.split(''));

/** 文の終わり */
export const SENTENCE_END = new Set('。！？!?'.split(''));

const KANJI_NUM: Record<string, string> = {
  〇: '0', 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9',
};

/**
 * 照合用に1文字を正規化する。記号・空白は '' を返す（照合に使わない）。
 * カタカナ→ひらがな、全角英数→半角・小文字、漢数字→算用数字。
 */
export function normChar(ch: string): string {
  let s = ch.normalize('NFKC').toLowerCase();
  let out = '';
  for (const c of s) {
    const code = c.codePointAt(0)!;
    if (code >= 0x30a1 && code <= 0x30f6) out += String.fromCodePoint(code - 0x60);
    else if (KANJI_NUM[c]) out += KANJI_NUM[c];
    else if (/[\p{L}\p{N}ー]/u.test(c)) out += c;
  }
  s = out;
  return s;
}

/** 正規化した文字列と、各文字が元の文字列のどこから来たか */
export function normalizeWithMap(text: string): { chars: string[]; src: number[] } {
  const chars: string[] = [];
  const src: number[] = [];
  let i = 0;
  for (const ch of text) {
    for (const n of normChar(ch)) {
      chars.push(n);
      src.push(i);
    }
    i += ch.length;
  }
  return { chars, src };
}
