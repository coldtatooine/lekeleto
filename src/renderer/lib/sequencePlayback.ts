/** Taxa usada na UI e no avanço frame-a-frame (alinhada ao cálculo de frames no import). */
export const SEQUENCE_FPS = 24;

const MIN_SEGMENT_SEC = 1 / SEQUENCE_FPS;

export type TimelineClipLike = {
  asset: { id: string; durationSec: number; playbackFps?: number };
  source: "user" | "library";
  libraryEntryId?: string;
};

/** Duração na linha do tempo (evita segmentos 0 s enquanto o clip ainda carrega). */
export function segmentDurationSec(row: TimelineClipLike): number {
  return Math.max(row.asset.durationSec, MIN_SEGMENT_SEC);
}

/** Tempo local (s) para o mixer; alinhado ao segmento da timeline (inclui MIN se duration ainda era 0 antes do fix do parser). */
function localAnimTime(row: TimelineClipLike, tInSegment: number): number {
  const cap = Math.max(row.asset.durationSec, MIN_SEGMENT_SEC);
  return Math.max(0, Math.min(tInSegment, cap));
}

export function totalSequenceDuration(rows: TimelineClipLike[]): number {
  return rows.reduce((s, c) => s + segmentDurationSec(c), 0);
}

export function resolveSequenceAtTime(
  rows: TimelineClipLike[],
  tSec: number
): { clip: TimelineClipLike | null; localTime: number; index: number } {
  if (rows.length === 0) return { clip: null, localTime: 0, index: -1 };
  const total = totalSequenceDuration(rows);
  if (total <= 0) {
    return { clip: rows[0], localTime: 0, index: 0 };
  }
  const t = Math.max(0, Math.min(tSec, total));
  let acc = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const seg = segmentDurationSec(row);
    if (i === rows.length - 1) {
      const raw = Math.max(0, Math.min(t - acc, seg));
      return {
        clip: row,
        localTime: localAnimTime(row, raw),
        index: i,
      };
    }
    if (t < acc + seg) {
      const raw = t - acc;
      return {
        clip: row,
        localTime: localAnimTime(row, raw),
        index: i,
      };
    }
    acc += seg;
  }
  return { clip: rows[rows.length - 1], localTime: 0, index: rows.length - 1 };
}

export function clipStartSec(
  rows: TimelineClipLike[],
  target: TimelineClipLike
): number {
  let acc = 0;
  for (const c of rows) {
    if (clipsEqual(c, target)) return acc;
    acc += segmentDurationSec(c);
  }
  return acc;
}

function clipsEqual(a: TimelineClipLike, b: TimelineClipLike): boolean {
  if (a.source !== b.source || a.asset.id !== b.asset.id) return false;
  if (a.source === "library" && b.source === "library") {
    return a.libraryEntryId === b.libraryEntryId;
  }
  return true;
}

export function formatTimecode(sec: number, fps: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const totalFrames = Math.floor(sec * fps + 1e-6);
  const ff = totalFrames % fps;
  const totalSec = Math.floor(totalFrames / fps);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(ff)}`;
  return `${pad(m)}:${pad(s)}:${pad(ff)}`;
}
