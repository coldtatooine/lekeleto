import type { Object3D } from "three";
import type { CameraPresetId } from "./cameraPresets";
import type { CaptureFrameParams } from "../viewer/Viewport3D";
import {
  SEQUENCE_FPS,
  resolveSequenceAtTime,
  segmentDurationSec,
  type TimelineClipLike,
} from "./sequencePlayback";

export type ExportTimelineClip = TimelineClipLike & {
  asset: TimelineClipLike["asset"] & { root: Object3D | null };
};

export async function runSequenceVideoExport(args: {
  totalDurationSec: number;
  timelineRows: ExportTimelineClip[];
  clipCameraPresets: Record<string, CameraPresetId>;
  timelineClipKey: (clip: TimelineClipLike) => string;
  captureFrame: (p: CaptureFrameParams) => Promise<ArrayBuffer>;
  syncToModel: (model: Object3D | null, animationTimeSec: number) => void;
  currentViewportModel: Object3D | null;
  currentViewportAnimationTime: number;
  opaqueBackground: boolean;
  exportWidth: number;
  exportHeight: number;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
}): Promise<{ mp4Path: string }> {
  const {
    totalDurationSec,
    timelineRows,
    clipCameraPresets,
    timelineClipKey,
    captureFrame,
    syncToModel,
    currentViewportModel,
    currentViewportAnimationTime,
    opaqueBackground,
    exportWidth,
    exportHeight,
    invoke,
  } = args;

  if (totalDurationSec <= 0) {
    throw new Error("Duração da sequência é zero.");
  }

  const fps = SEQUENCE_FPS;
  const frameCount = Math.max(1, Math.ceil(totalDurationSec * fps));

  const { framesDir } = (await invoke("export:createFramesDir")) as {
    framesDir: string;
  };

  const mp4Path = (await invoke("export:nextExportPath")) as string;

  try {
    for (let i = 0; i < frameCount; i++) {
      const sequenceTimeSec = Math.min(i / fps, totalDurationSec - 1e-6);
      const r = resolveSequenceAtTime(timelineRows, sequenceTimeSec);
      const clip = r.clip as ExportTimelineClip | null;
      const root = clip?.asset?.root ?? null;
      if (!clip || !root) {
        throw new Error("Sequência sem modelo num frame do export.");
      }

      const k = timelineClipKey(clip);
      const preset = clipCameraPresets[k] ?? "default";
      const segDur = segmentDurationSec(clip);
      const u =
        segDur > 0
          ? Math.min(1, Math.max(0, r.localTime / segDur))
          : 0;

      const buffer = await captureFrame({
        model: root,
        animationLocalTimeSec: r.localTime,
        cameraPreset: preset,
        cameraPhaseU: u,
        sequenceTimeSec,
        width: exportWidth,
        height: exportHeight,
        opaqueBackground,
      });

      await invoke("export:writeFrame", {
        framesDir,
        frameIndex: i,
        buffer,
      });
    }

    await invoke("export:encodeVideo", {
      framesDir,
      outputFile: mp4Path,
      fps,
    });

    return { mp4Path };
  } finally {
    try {
      await invoke("export:rmDir", framesDir);
    } catch {
      /* pasta já removida ou indisponível */
    }
    syncToModel(currentViewportModel, currentViewportAnimationTime);
  }
}
