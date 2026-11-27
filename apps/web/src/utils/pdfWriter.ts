/**
 * Zero-dependency, spec-compliant single-page PDF 1.4 writer.
 * Wraps a high-DPI RGB JPEG stream (/DCTDecode) into exact physical print page
 * dimensions (/MediaBox & /CropBox in PostScript points, 1 pt = 1/72 inch).
 *
 * Why JPEG-wrapped high-DPI PDF?
 * - Preserves 100% WYSIWYG CJK typography, embedded SIL OFL IPA fonts, OpenType
 *   Chao 5-level tone contour ligatures (GSUB/GPOS), gradients, risograph blend
 *   modes, and acoustic spectrogram details with zero missing-font issues in
 *   Adobe Acrobat, macOS Preview, browsers, and print shops.
 * - Zero external dependencies and compact file size (~0.6–2.5 MB at print DPI).
 */

export interface SinglePagePdfInput {
  /** Raw JPEG bytes (baseline RGB, SOI 0xFF 0xD8 .. EOI 0xFF 0xD9). */
  jpegBytes: Uint8Array;
  /** Pixel width of the JPEG image. */
  pixelWidth: number;
  /** Pixel height of the JPEG image. */
  pixelHeight: number;
  /** Physical PDF page width in PostScript points (1 pt = 1/72 inch). */
  pageWidthPt: number;
  /** Physical PDF page height in PostScript points (1 pt = 1/72 inch). */
  pageHeightPt: number;
  /** Optional PDF document title (supports full Unicode via UTF-16BE BOM). */
  title?: string;
}

const ASCII_ENC = new TextEncoder();

function encodeAscii(str: string): Uint8Array {
  return ASCII_ENC.encode(str);
}

/** Encode arbitrary Unicode string as a PDF UTF-16BE hex string (<FEFF...>). */
function encodePdfUnicodeHex(str: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < str.length; i++) {
    hex += str.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  }
  return `<${hex}>`;
}

function formatPdfDate(d: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const tzOffsetMin = -d.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(tzOffsetMin);
  const tzH = pad2(Math.floor(absMin / 60));
  const tzM = pad2(absMin % 60);
  return (
    `D:${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}${sign}${tzH}'${tzM}'`
  );
}

/**
 * Build a valid single-page PDF 1.4 binary buffer from a JPEG image and exact page pt dimensions.
 */
export function buildSinglePageJpegPdf(input: SinglePagePdfInput): Uint8Array<ArrayBuffer> {
  const { jpegBytes, pixelWidth, pixelHeight } = input;
  if (!jpegBytes || jpegBytes.length < 4 || jpegBytes[0] !== 0xff || jpegBytes[1] !== 0xd8) {
    throw new Error('无效的 JPEG 图像数据，无法封装为 PDF');
  }
  const wPt = Math.max(1, Number.isFinite(input.pageWidthPt) ? input.pageWidthPt : 595.28);
  const hPt = Math.max(1, Number.isFinite(input.pageHeightPt) ? input.pageHeightPt : 841.89);
  const pxW = Math.max(1, Math.round(pixelWidth));
  const pxH = Math.max(1, Math.round(pixelHeight));

  const wStr = wPt.toFixed(2);
  const hStr = hPt.toFixed(2);

  const chunks: Uint8Array[] = [];
  let offset = 0;

  const push = (buf: Uint8Array) => {
    chunks.push(buf);
    offset += buf.length;
  };
  const pushStr = (s: string) => push(encodeAscii(s));

  // Header + 4 high-bit binary marker bytes per PDF 1.4 spec §3.4.1
  pushStr('%PDF-1.4\n%');
  push(new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // Object byte offsets (1-indexed; index 0 unused)
  const objOffsets: number[] = [0];

  // 1: Catalog
  objOffsets.push(offset);
  pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // 2: Pages
  objOffsets.push(offset);
  pushStr('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  // 3: Page
  objOffsets.push(offset);
  pushStr(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wStr} ${hStr}] /CropBox [0 0 ${wStr} ${hStr}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> /ProcSet [/PDF /ImageC] >> /Contents 5 0 R >>\nendobj\n`
  );

  // 4: Image XObject (/DCTDecode raw JPEG bytes)
  objOffsets.push(offset);
  pushStr(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`
  );
  push(jpegBytes);
  pushStr('\nendstream\nendobj\n');

  // 5: Page Content Stream (paint full-bleed /Im0 at exact physical page size)
  const contentStream = `q\n${wStr} 0 0 ${hStr} 0 0 cm\n/Im0 Do\nQ\n`;
  const contentBytes = encodeAscii(contentStream);
  objOffsets.push(offset);
  pushStr(`5 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
  push(contentBytes);
  pushStr('endstream\nendobj\n');

  // 6: Document Info Dictionary
  const titleHex = encodePdfUnicodeHex(input.title || 'T·Grid Poster');
  const creatorHex = encodePdfUnicodeHex('T·Grid - TextGrid Editor');
  const dateStr = formatPdfDate(new Date());
  objOffsets.push(offset);
  pushStr(
    `6 0 obj\n<< /Title ${titleHex} /Creator ${creatorHex} /Producer (T-Grid Direct PDF Writer) /CreationDate (${dateStr}) >>\nendobj\n`
  );

  // Cross-reference table (exact 20-byte entries)
  const xrefOffset = offset;
  const objCount = objOffsets.length;
  pushStr(`xref\n0 ${objCount}\n`);
  pushStr('0000000000 65535 f \n');
  for (let i = 1; i < objCount; i++) {
    pushStr(`${String(objOffsets[i]).padStart(10, '0')} 00000 n \n`);
  }

  // Trailer
  pushStr(
    `trailer\n<< /Size ${objCount} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  );

  // Concatenate into a single contiguous Uint8Array
  const out = new Uint8Array(offset);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
