import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { Object3D } from "three";
import { LIBRARY_ITEMS, type LibraryItem } from "../library";
import { LanguageMenu } from "./components/LanguageMenu";
import {
  CAMERA_PRESET_IDS,
  type CameraPresetId,
} from "./lib/cameraPresets";
import {
  SEQUENCE_FPS,
  clipStartSec,
  formatTimecode,
  resolveSequenceAtTime,
  segmentDurationSec,
  totalSequenceDuration,
  type TimelineClipLike,
} from "./lib/sequencePlayback";
import {
  detectFormat,
  disposeObject3D,
  type AssetFormat,
  parseModelBuffer,
} from "./lib/modelLoader";
import { runSequenceVideoExport, type ExportTimelineClip } from "./lib/videoExport";
import {
  Viewport3D,
  type Viewport3DHandle,
} from "./viewer/Viewport3D";
import type { ComfySettings } from "./lekeleto";

type SidebarTab = "assets" | "scene" | "export";
type SequencePanelTab = "loaded" | "library";

type Selection =
  | { kind: "user"; id: string }
  | { kind: "library"; entryId: string };

type LoadedAsset = {
  id: string;
  name: string;
  format: AssetFormat;
  fileSize: number;
  buffer: ArrayBuffer;
  icon: string;
  root: Object3D | null;
  durationSec: number;
  /** FPS estimado a partir dos keyframes do clip (passo frame / timecode). */
  playbackFps: number;
  frames: number;
  bones: number;
  loading: boolean;
  parseError?: string;
};

type TimelineClip = {
  asset: LoadedAsset;
  source: "user" | "library";
  libraryEntryId?: string;
};

function timelineClipKey(clip: TimelineClipLike): string {
  if (clip.source === "library" && clip.libraryEntryId) {
    return `lib:${clip.libraryEntryId}`;
  }
  return `user:${clip.asset.id}`;
}

function formatShortLabel(f: AssetFormat): string {
  switch (f) {
    case "COLLADA":
      return "DAE";
    case "FBX":
      return "FBX";
    case "GLB":
      return "GLB";
    default:
      return "?";
  }
}

function thumbClassForFormat(f: AssetFormat): string {
  switch (f) {
    case "COLLADA":
      return "tl-thumb--dae";
    case "FBX":
      return "tl-thumb--fbx";
    case "GLB":
      return "tl-thumb--glb";
    default:
      return "";
  }
}

function isTimelineClipSelected(
  clip: TimelineClip,
  sel: Selection | null
): boolean {
  if (!sel) return false;
  if (clip.source === "user") {
    return sel.kind === "user" && sel.id === clip.asset.id;
  }
  return (
    sel.kind === "library" &&
    clip.libraryEntryId !== undefined &&
    sel.entryId === clip.libraryEntryId
  );
}

function iconForFormat(f: AssetFormat): string {
  switch (f) {
    case "COLLADA":
      return "🦾";
    case "FBX":
      return "📦";
    case "GLB":
      return "✨";
    default:
      return "◇";
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(sec: number): string {
  if (sec <= 0) return "—";
  return `${sec.toFixed(1)}s`;
}

function buildTimelineRows(
  assets: LoadedAsset[],
  libraryCache: Record<string, LoadedAsset>
): TimelineClip[] {
  const userClips: TimelineClip[] = assets.map((a) => ({
    asset: a,
    source: "user" as const,
  }));
  const libClips: TimelineClip[] = Object.entries(libraryCache)
    .filter(([, a]) => !a.loading && a.root && !a.parseError)
    .map(([entryId, a]) => ({
      asset: a,
      source: "library" as const,
      libraryEntryId: entryId,
    }));
  return [...userClips, ...libClips];
}

function selectionFromClip(clip: TimelineClipLike): Selection {
  if (clip.source === "user") return { kind: "user", id: clip.asset.id };
  return { kind: "library", entryId: clip.libraryEntryId! };
}

function selectionMatchesClip(
  sel: Selection | null,
  clip: TimelineClipLike
): boolean {
  if (!sel) return false;
  if (clip.source === "user") {
    return sel.kind === "user" && sel.id === clip.asset.id;
  }
  return (
    sel.kind === "library" && sel.entryId === clip.libraryEntryId
  );
}

/** Mesmo asset que o clip (por id), sem depender do estado selection (evita 1 frame atrasado). */
function clipMatchesViewportAsset(
  clip: TimelineClipLike,
  asset: LoadedAsset | null | undefined
): boolean {
  if (!asset) return false;
  return clip.asset.id === asset.id;
}

function asArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  ) as ArrayBuffer;
}

type ExportedVideoItem = {
  name: string;
  fullPath: string;
  mtimeMs: number;
};

function fileBasename(filePath: string): string {
  const n = filePath.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : filePath;
}

export default function App() {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<SidebarTab>("assets");
  const [sequencePanelTab, setSequencePanelTab] =
    useState<SequencePanelTab>("loaded");
  const [assets, setAssets] = useState<LoadedAsset[]>([]);
  const [libraryCache, setLibraryCache] = useState<
    Record<string, LoadedAsset>
  >({});
  const [selection, setSelection] = useState<Selection | null>(null);
  /** Hover na lista / timeline: mostra o modelo no viewport sem alterar a seleção. */
  const [previewHover, setPreviewHover] = useState<Selection | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<Viewport3DHandle>(null);
  const [renderOpts, setRenderOpts] = useState({
    shadows: true,
    motionBlur: false,
    background: true,
  });
  const [sequenceTimeSec, setSequenceTimeSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loopSequence, setLoopSequence] = useState(false);
  const [clipCameraPresets, setClipCameraPresets] = useState<
    Record<string, CameraPresetId>
  >({});
  const [exportBusy, setExportBusy] = useState(false);
  const [exportErrorToast, setExportErrorToast] = useState<string | null>(null);
  const [exportSuccessToast, setExportSuccessToast] = useState<string | null>(
    null
  );
  const [exportSuccessKind, setExportSuccessKind] = useState<
    "export" | "genai"
  >("export");
  const [comfySettings, setComfySettings] = useState<ComfySettings | null>(
    null
  );
  const [genAiComfyBusy, setGenAiComfyBusy] = useState(false);
  const [genAiComfyError, setGenAiComfyError] = useState<string | null>(null);
  const comfySettingsRef = useRef<ComfySettings | null>(null);
  const [exportedVideos, setExportedVideos] = useState<ExportedVideoItem[]>(
    []
  );
  /** Caminho absoluto do MP4 selecionado para o preview da fila de saída. */
  const [outputQueuePreviewPath, setOutputQueuePreviewPath] = useState<
    string | null
  >(null);
  const [outputQueuePreviewUrl, setOutputQueuePreviewUrl] = useState<
    string | null
  >(null);
  /** Um único MP4 da fila escolhido para geração com IA (independente do preview). */
  const [genAiSelectedPath, setGenAiSelectedPath] = useState<string | null>(
    null
  );
  const [genAiPrompt, setGenAiPrompt] = useState("");
  const [genAiPromptModalOpen, setGenAiPromptModalOpen] = useState(false);
  const genAiModalTextareaRef = useRef<HTMLTextAreaElement>(null);

  const loadOutputQueue = useCallback(async () => {
    const api = typeof window !== "undefined" ? window.lekeleto : undefined;
    if (!api?.invoke) {
      setExportedVideos([]);
      return;
    }
    try {
      const list = (await api.invoke("export:listVideos")) as ExportedVideoItem[];
      setExportedVideos(Array.isArray(list) ? list : []);
    } catch {
      setExportedVideos([]);
    }
  }, []);

  const loadComfySettings = useCallback(async () => {
    const api = typeof window !== "undefined" ? window.lekeleto : undefined;
    if (!api?.invoke) {
      setComfySettings(null);
      return;
    }
    try {
      const s = (await api.invoke("comfy:getSettings")) as ComfySettings;
      setComfySettings(s);
    } catch {
      setComfySettings(null);
    }
  }, []);

  const persistComfySettings = useCallback(async (next: ComfySettings) => {
    const api = typeof window !== "undefined" ? window.lekeleto : undefined;
    if (!api?.invoke) return;
    try {
      const saved = (await api.invoke("comfy:setSettings", next)) as ComfySettings;
      setComfySettings(saved);
    } catch {
      /* ignore */
    }
  }, []);

  const handlePickComfyWorkflow = useCallback(async () => {
    const api = typeof window !== "undefined" ? window.lekeleto : undefined;
    if (!api?.invoke) {
      setGenAiComfyError(null);
      return;
    }
    setGenAiComfyError(null);
    try {
      const r = (await api.invoke("comfy:pickWorkflowFile")) as
        | { canceled: true }
        | { canceled: false; path: string };
      if (!r.canceled && "path" in r) {
        const saved = (await api.invoke("comfy:setSettings", {
          workflowApiPath: r.path,
        })) as ComfySettings;
        setComfySettings(saved);
      }
    } catch (e) {
      setGenAiComfyError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleGenAiComfy = useCallback(async () => {
    const api = typeof window !== "undefined" ? window.lekeleto : undefined;
    if (!api?.invoke) {
      setGenAiComfyError(t("genai.errorNoElectron"));
      return;
    }
    if (!genAiSelectedPath) {
      setGenAiComfyError(t("genai.errorNoVideo"));
      return;
    }
    const promptTrim = genAiPrompt.trim();
    if (!promptTrim) {
      setGenAiComfyError(t("genai.errorNoPrompt"));
      return;
    }
    if (!comfySettings?.workflowApiPath) {
      setGenAiComfyError(t("genai.errorNoWorkflow"));
      return;
    }
    if (
      !comfySettings.injection.videoNodeId ||
      !comfySettings.injection.promptNodeId
    ) {
      setGenAiComfyError(t("genai.errorNoNodes"));
      return;
    }
    setGenAiComfyError(null);
    setExportErrorToast(null);
    setExportSuccessToast(null);
    setGenAiComfyBusy(true);
    try {
      await api.invoke("comfy:setSettings", comfySettings);
      const { outputPath } = (await api.invoke("comfy:v2v", {
        inputVideoPath: genAiSelectedPath,
        prompt: promptTrim,
      })) as { outputPath: string };
      setExportSuccessKind("genai");
      setExportSuccessToast(outputPath);
      void loadOutputQueue();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setExportErrorToast(msg);
    } finally {
      setGenAiComfyBusy(false);
    }
  }, [
    genAiSelectedPath,
    genAiPrompt,
    comfySettings,
    t,
    loadOutputQueue,
  ]);

  const openVideoInExplorer = useCallback(
    async (filePath: string) => {
      const api = window.lekeleto;
      if (!api?.invoke) return;
      try {
        await api.invoke("export:showInExplorer", { filePath });
      } catch {
        setExportErrorToast(t("exportVideo.openExplorerFailed"));
      }
    },
    [t]
  );

  const loopSequenceRef = useRef(loopSequence);
  loopSequenceRef.current = loopSequence;
  const timelineRowsRef = useRef<TimelineClip[]>([]);
  const assetsRef = useRef(assets);
  assetsRef.current = assets;

  const selected = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === "user") {
      return assets.find((a) => a.id === selection.id) ?? null;
    }
    return libraryCache[selection.entryId] ?? null;
  }, [selection, assets, libraryCache]);

  const previewAsset = useMemo(() => {
    if (!previewHover) return null;
    if (previewHover.kind === "user") {
      return assets.find((a) => a.id === previewHover.id) ?? null;
    }
    return libraryCache[previewHover.entryId] ?? null;
  }, [previewHover, assets, libraryCache]);

  const previewDiffersFromSelection = useMemo(() => {
    if (!previewHover || !selection) return false;
    if (selection.kind === "user" && previewHover.kind === "user") {
      return selection.id !== previewHover.id;
    }
    if (selection.kind === "library" && previewHover.kind === "library") {
      return selection.entryId !== previewHover.entryId;
    }
    return true;
  }, [previewHover, selection]);

  const isViewportPreview =
    Boolean(previewHover && previewAsset?.root && !previewAsset.parseError) &&
    previewDiffersFromSelection;

  const formatNeon = selected?.format === "COLLADA";

  const timelineRows = useMemo(
    () => buildTimelineRows(assets, libraryCache),
    [assets, libraryCache]
  );
  timelineRowsRef.current = timelineRows;

  const totalDuration = useMemo(
    () => totalSequenceDuration(timelineRows),
    [timelineRows]
  );

  const resolvedPlayback = useMemo(
    () => resolveSequenceAtTime(timelineRows, sequenceTimeSec),
    [timelineRows, sequenceTimeSec]
  );

  const viewportModel = useMemo(() => {
    const playbackClip = resolvedPlayback.clip as TimelineClip | null;
    if (isPlaying && playbackClip?.asset?.root) {
      return playbackClip.asset.root;
    }
    if (previewHover && previewAsset?.root && !previewAsset.parseError) {
      return previewAsset.root;
    }
    return selected?.root ?? null;
  }, [
    isPlaying,
    resolvedPlayback,
    previewHover,
    previewAsset,
    selected,
  ]);

  const selectedTimelineClip = useMemo(() => {
    if (!selection) return null;
    return (
      timelineRows.find((c) => isTimelineClipSelected(c, selection)) ?? null
    );
  }, [timelineRows, selection]);

  const viewportCameraContext = useMemo(() => {
    const defaultCtx = { preset: "default" as CameraPresetId, u: 0 };
    if (!viewportModel) return defaultCtx;

    const clipFromPreview =
      isViewportPreview && previewHover
        ? timelineRows.find((c) => isTimelineClipSelected(c, previewHover))
        : null;

    if (clipFromPreview) {
      const k = timelineClipKey(clipFromPreview);
      return {
        preset: clipCameraPresets[k] ?? "default",
        u: 0,
      };
    }

    const clip = resolvedPlayback.clip as TimelineClip | null;
    if (!clip) return defaultCtx;
    const segDur = segmentDurationSec(clip);
    const u =
      segDur > 0
        ? Math.min(1, Math.max(0, resolvedPlayback.localTime / segDur))
        : 0;
    const k = timelineClipKey(clip);
    return {
      preset: clipCameraPresets[k] ?? "default",
      u,
    };
  }, [
    viewportModel,
    isViewportPreview,
    previewHover,
    timelineRows,
    resolvedPlayback,
    clipCameraPresets,
  ]);

  useEffect(() => {
    void loadOutputQueue();
  }, [loadOutputQueue]);

  useEffect(() => {
    void loadComfySettings();
  }, [loadComfySettings]);

  useEffect(() => {
    comfySettingsRef.current = comfySettings;
  }, [comfySettings]);

  const persistComfyFromRef = useCallback(() => {
    const cur = comfySettingsRef.current;
    if (cur) void persistComfySettings(cur);
  }, [persistComfySettings]);

  useEffect(() => {
    if (exportedVideos.length === 0) {
      setOutputQueuePreviewPath(null);
      return;
    }
    setOutputQueuePreviewPath((prev) => {
      if (prev && exportedVideos.some((v) => v.fullPath === prev)) return prev;
      return exportedVideos[0].fullPath;
    });
  }, [exportedVideos]);

  useEffect(() => {
    if (!outputQueuePreviewPath) {
      setOutputQueuePreviewUrl(null);
      return;
    }
    setOutputQueuePreviewUrl(null);
    let cancelled = false;
    const api = typeof window !== "undefined" ? window.lekeleto : undefined;
    if (!api?.invoke) return;
    void (async () => {
      try {
        const url = (await api.invoke(
          "export:videoFileUrl",
          outputQueuePreviewPath
        )) as string;
        if (!cancelled) setOutputQueuePreviewUrl(url);
      } catch {
        if (!cancelled) setOutputQueuePreviewUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [outputQueuePreviewPath]);

  useEffect(() => {
    if (!genAiSelectedPath) return;
    if (!exportedVideos.some((v) => v.fullPath === genAiSelectedPath)) {
      setGenAiSelectedPath(null);
    }
  }, [exportedVideos, genAiSelectedPath]);

  const genAiSelectedName = useMemo(() => {
    if (!genAiSelectedPath) return null;
    const row = exportedVideos.find((v) => v.fullPath === genAiSelectedPath);
    return row?.name ?? fileBasename(genAiSelectedPath);
  }, [genAiSelectedPath, exportedVideos]);

  const toggleGenAiSelection = useCallback((fullPath: string) => {
    setGenAiSelectedPath((prev) => (prev === fullPath ? null : fullPath));
  }, []);

  useEffect(() => {
    if (!genAiPromptModalOpen) return;
    const id = requestAnimationFrame(() => {
      genAiModalTextareaRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [genAiPromptModalOpen]);

  useEffect(() => {
    if (!genAiPromptModalOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setGenAiPromptModalOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [genAiPromptModalOpen]);

  useEffect(() => {
    setSequenceTimeSec((t) =>
      Math.min(Math.max(0, t), Math.max(0, totalDuration))
    );
  }, [totalDuration]);

  useEffect(() => {
    if (timelineRows.length === 0) {
      setSelection((sel) => {
        if (
          sel?.kind === "library" &&
          libraryCache[sel.entryId]?.loading
        ) {
          return sel;
        }
        return null;
      });
      return;
    }
    const r = resolveSequenceAtTime(timelineRows, sequenceTimeSec);
    const clipAtPlayhead = r.clip;
    if (!clipAtPlayhead) return;
    setSelection((sel) => {
      if (
        sel?.kind === "library" &&
        libraryCache[sel.entryId]?.loading
      ) {
        return sel;
      }
      if (sel && selectionMatchesClip(sel, clipAtPlayhead)) return sel;
      return selectionFromClip(clipAtPlayhead);
    });
  }, [sequenceTimeSec, timelineRows, libraryCache]);

  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const rows = timelineRowsRef.current;
      const total = totalSequenceDuration(rows);
      if (total <= 0) {
        setIsPlaying(false);
        return;
      }
      setSequenceTimeSec((prev) => {
        let next = prev + dt;
        if (next >= total) {
          if (loopSequenceRef.current) {
            next = next % total;
          } else {
            next = total;
            queueMicrotask(() => setIsPlaying(false));
          }
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  const deleteTimelineClip = useCallback((clip: TimelineClip) => {
    const presetKey = timelineClipKey(clip);
    setClipCameraPresets((prev) => {
      if (!(presetKey in prev)) return prev;
      const next = { ...prev };
      delete next[presetKey];
      return next;
    });
    if (clip.asset.root) {
      disposeObject3D(clip.asset.root);
    }
    if (clip.source === "user") {
      setAssets((prev) => prev.filter((a) => a.id !== clip.asset.id));
    } else if (clip.libraryEntryId) {
      const eid = clip.libraryEntryId;
      setLibraryCache((prev) => {
        const next = { ...prev };
        delete next[eid];
        return next;
      });
    }
  }, []);

  const selectTimelineClip = useCallback((clip: TimelineClip) => {
    setSequenceTimeSec(clipStartSec(timelineRows, clip));
    setIsPlaying(false);
  }, [timelineRows]);

  const clipCountLabel = useMemo(() => {
    const libReady = Object.values(libraryCache).filter(
      (a) => a.root && !a.parseError
    ).length;
    return t("viewer.clipCount", { count: assets.length + libReady });
  }, [assets, libraryCache, t]);

  const viewportAnimationTime = useMemo(() => {
    const playbackPose = (): number => {
      const c = resolvedPlayback.clip;
      const asset =
        previewHover && previewAsset?.root && !previewAsset.parseError
          ? previewAsset
          : selected;
      if (!c || !asset?.root) return 0;
      if (!clipMatchesViewportAsset(c, asset)) return 0;
      return resolvedPlayback.localTime;
    };

    const playbackClip = resolvedPlayback.clip as TimelineClip | null;
    if (isPlaying && playbackClip?.asset?.root) {
      return resolvedPlayback.localTime;
    }

    if (previewHover) {
      const sameAsSelection =
        selection &&
        ((selection.kind === "user" &&
          previewHover.kind === "user" &&
          selection.id === previewHover.id) ||
          (selection.kind === "library" &&
            previewHover.kind === "library" &&
            selection.entryId === previewHover.entryId));
      if (sameAsSelection) return playbackPose();
      return 0;
    }
    return playbackPose();
  }, [
    isPlaying,
    previewHover,
    previewAsset,
    resolvedPlayback,
    selected,
    selection,
  ]);

  const activePlaybackFps = useMemo(() => {
    const c = resolvedPlayback.clip as TimelineClip | null;
    const a = c?.asset as LoadedAsset | undefined;
    return a?.playbackFps ?? SEQUENCE_FPS;
  }, [resolvedPlayback]);

  const frameStepSec = useMemo(
    () => 1 / activePlaybackFps,
    [activePlaybackFps]
  );

  const sceneLocalTimecode = useMemo(
    () =>
      formatTimecode(
        resolvedPlayback.clip ? resolvedPlayback.localTime : 0,
        activePlaybackFps
      ),
    [resolvedPlayback, activePlaybackFps]
  );

  const seekSequenceStart = useCallback(() => {
    setSequenceTimeSec(0);
    setIsPlaying(false);
  }, []);
  const seekSequenceEnd = useCallback(() => {
    setSequenceTimeSec(totalDuration);
    setIsPlaying(false);
  }, [totalDuration]);
  const stepPrevFrame = useCallback(() => {
    setSequenceTimeSec((t) => Math.max(0, t - frameStepSec));
    setIsPlaying(false);
  }, [frameStepSec]);
  const stepNextFrame = useCallback(() => {
    setSequenceTimeSec((t) => Math.min(totalDuration, t + frameStepSec));
    setIsPlaying(false);
  }, [frameStepSec, totalDuration]);
  const togglePlay = useCallback(() => {
    if (totalDuration <= 0) return;
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    if (sequenceTimeSec >= totalDuration - 1e-6) {
      setSequenceTimeSec(0);
    }
    setIsPlaying(true);
  }, [totalDuration, sequenceTimeSec, isPlaying]);
  const seekFromClientX = useCallback(
    (clientX: number, el: HTMLDivElement) => {
      const total = totalSequenceDuration(timelineRowsRef.current);
      if (total <= 0) return;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(
        0,
        Math.min(1, (clientX - rect.left) / rect.width)
      );
      setSequenceTimeSec(ratio * total);
    },
    []
  );
  const onTrackPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (totalDuration <= 0) return;
      const el = e.currentTarget;
      setIsPlaying(false);
      seekFromClientX(e.clientX, el);
      const move = (ev: globalThis.PointerEvent) =>
        seekFromClientX(ev.clientX, el);
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    },
    [seekFromClientX, totalDuration]
  );

  const handleExportVideo = useCallback(async () => {
    const api = typeof window !== "undefined" ? window.lekeleto : undefined;
    if (!api?.invoke) {
      setExportSuccessToast(null);
      setExportErrorToast(t("exportVideo.noElectron"));
      return;
    }
    if (totalDuration <= 0) return;
    const vp = viewportRef.current;
    if (!vp) return;
    setExportBusy(true);
    setIsPlaying(false);
    setExportSuccessToast(null);
    setExportErrorToast(null);
    try {
      const snapshotModel = viewportModel;
      const snapshotAnim = viewportAnimationTime;
      const result = await runSequenceVideoExport({
        totalDurationSec: totalDuration,
        timelineRows: timelineRows as ExportTimelineClip[],
        clipCameraPresets,
        timelineClipKey,
        captureFrame: (p) => vp.captureFrame(p),
        syncToModel: (m, anim) => vp.syncToModel(m, anim),
        currentViewportModel: snapshotModel,
        currentViewportAnimationTime: snapshotAnim,
        opaqueBackground: renderOpts.background,
        exportWidth: 1280,
        exportHeight: 720,
        invoke: (channel, ...args) => api.invoke(channel, ...args),
      });
      setExportSuccessKind("export");
      setExportSuccessToast(result.mp4Path);
      void loadOutputQueue();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setExportSuccessToast(null);
      setExportErrorToast(t("exportVideo.failed", { msg }));
    } finally {
      setExportBusy(false);
    }
  }, [
    totalDuration,
    timelineRows,
    clipCameraPresets,
    viewportModel,
    viewportAnimationTime,
    renderOpts.background,
    t,
    loadOutputQueue,
  ]);

  const dismissExportErrorToast = useCallback(() => {
    setExportErrorToast(null);
  }, []);

  const dismissExportSuccessToast = useCallback(() => {
    setExportSuccessToast(null);
  }, []);

  const copyExportSuccessPath = useCallback(async () => {
    if (!exportSuccessToast) return;
    try {
      await navigator.clipboard.writeText(exportSuccessToast);
    } catch {
      setImportMsg(t("exportVideo.copyFailed"));
    }
  }, [exportSuccessToast, t]);

  const copyExportErrorToast = useCallback(async () => {
    if (!exportErrorToast) return;
    try {
      await navigator.clipboard.writeText(exportErrorToast);
    } catch {
      setImportMsg(t("exportVideo.copyFailed"));
    }
  }, [exportErrorToast, t]);

  const playheadPct =
    totalDuration > 0
      ? Math.min(100, (sequenceTimeSec / totalDuration) * 100)
      : 0;

  const ingestBuffer = useCallback(
    async (buffer: ArrayBuffer, name: string, fileSize: number) => {
      const fmt = detectFormat(name);
      if (!fmt) {
        setImportMsg(t("errors.unsupportedExt", { name }));
        return;
      }
      const id = crypto.randomUUID();
      setImportMsg(null);
      setSequencePanelTab("loaded");
      setAssets((prev) => {
        const start = prev.reduce((s, a) => s + a.durationSec, 0);
        queueMicrotask(() => {
          setSequenceTimeSec(start);
          setIsPlaying(false);
        });
        return [
          ...prev,
          {
            id,
            name,
            format: fmt,
            fileSize,
            buffer,
            icon: iconForFormat(fmt),
            root: null,
            durationSec: 0,
            playbackFps: SEQUENCE_FPS,
            frames: 0,
            bones: 0,
            loading: true,
          },
        ];
      });
      try {
        const parsed = await parseModelBuffer(buffer, name);
        setAssets((prev) =>
          prev.map((a) =>
            a.id === id
              ? {
                  ...a,
                  loading: false,
                  root: parsed.root,
                  durationSec: parsed.durationSec,
                  playbackFps: parsed.playbackFps,
                  frames: Math.max(
                    0,
                    Math.round(parsed.durationSec * parsed.playbackFps)
                  ),
                  bones: parsed.bones,
                }
              : a
          )
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setAssets((prev) =>
          prev.map((a) =>
            a.id === id
              ? { ...a, loading: false, parseError: msg }
              : a
          )
        );
        setImportMsg(t("errors.readFail", { name, msg }));
      }
    },
    [t]
  );

  const loadLibraryEntry = useCallback(
    async (entry: LibraryItem) => {
      setSequencePanelTab("library");
      const existing = libraryCache[entry.id];
      if (existing?.loading) return;
      if (existing?.root && !existing.parseError) {
        selectTimelineClip({
          asset: existing,
          source: "library",
          libraryEntryId: entry.id,
        });
        return;
      }

      setSelection({ kind: "library", entryId: entry.id });

      setLibraryCache((prev) => ({
        ...prev,
        [entry.id]: {
          id: `lib-${entry.id}`,
          name: entry.name,
          format: entry.format,
          fileSize: 0,
          buffer: new ArrayBuffer(0),
          icon: iconForFormat(entry.format),
          root: null,
          durationSec: 0,
          playbackFps: SEQUENCE_FPS,
          frames: 0,
          bones: 0,
          loading: true,
        },
      }));

      try {
        const res = await fetch(entry.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const parsed = await parseModelBuffer(buf, entry.name);
        setLibraryCache((prev) => {
          const next = {
            ...prev,
            [entry.id]: {
              id: `lib-${entry.id}`,
              name: entry.name,
              format: entry.format,
              fileSize: buf.byteLength,
              buffer: buf,
              icon: iconForFormat(entry.format),
              root: parsed.root,
              durationSec: parsed.durationSec,
              playbackFps: parsed.playbackFps,
              frames: Math.max(
                0,
                Math.round(parsed.durationSec * parsed.playbackFps)
              ),
              bones: parsed.bones,
              loading: false,
            },
          };
          const rows = buildTimelineRows(assetsRef.current, next);
          const clip = rows.find(
            (c) => c.source === "library" && c.libraryEntryId === entry.id
          );
          queueMicrotask(() => {
            if (clip) setSequenceTimeSec(clipStartSec(rows, clip));
            setIsPlaying(false);
          });
          return next;
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setLibraryCache((prev) => ({
          ...prev,
          [entry.id]: {
            id: `lib-${entry.id}`,
            name: entry.name,
            format: entry.format,
            fileSize: 0,
            buffer: new ArrayBuffer(0),
            icon: iconForFormat(entry.format),
            root: null,
            durationSec: 0,
            playbackFps: SEQUENCE_FPS,
            frames: 0,
            bones: 0,
            loading: false,
            parseError: msg,
          },
        }));
      }
    },
    [libraryCache, selectTimelineClip]
  );

  const onImportClick = useCallback(async () => {
    setImportMsg(null);
    const api = window.lekeleto;
    if (api?.openAssetDialog && api.readAssetFile) {
      const d = await api.openAssetDialog();
      if (d.canceled) return;
      for (const p of d.paths) {
        const r = await api.readAssetFile(p);
        await ingestBuffer(asArrayBuffer(r.buffer), r.name, r.size);
      }
      return;
    }
    fileInputRef.current?.click();
  }, [ingestBuffer]);

  const onFileInput = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const list = e.target.files;
      if (!list?.length) return;
      for (const f of list) {
        const buf = await f.arrayBuffer();
        await ingestBuffer(buf, f.name, f.size);
      }
      e.target.value = "";
    },
    [ingestBuffer]
  );

  const onDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      setImportMsg(null);
      const files = [...e.dataTransfer.files];
      for (const f of files) {
        const buf = await f.arrayBuffer();
        await ingestBuffer(buf, f.name, f.size);
      }
    },
    [ingestBuffer]
  );

  const isUserSelected = (id: string) =>
    selection?.kind === "user" && selection.id === id;
  const isLibrarySelected = (entryId: string) =>
    selection?.kind === "library" && selection.entryId === entryId;

  return (
    <div className="lekeleto-app">
      <input
        ref={fileInputRef}
        type="file"
        accept=".dae,.fbx,.glb"
        multiple
        hidden
        onChange={onFileInput}
      />

      <header className="titlebar">
        <div className="titlebar-logo">
          <div className="logo-mark">Lk</div>
          <span className="logo-name">Lekeleto</span>
        </div>
        <span className="titlebar-breadcrumb">
          / <span>{t("titlebar.breadcrumbScene")}</span> /{" "}
          <span>{t("titlebar.breadcrumbClip")}</span>
        </span>
        <div className="titlebar-spacer" />
        <div className="titlebar-actions">
          <button type="button" className="btn-import" onClick={onImportClick}>
            {t("titlebar.import")}
          </button>
          <LanguageMenu />
          <div style={{ width: 12 }} aria-hidden />
          <button
            type="button"
            className="win-btn win-min"
            aria-label={t("titlebar.minimize")}
          />
          <button
            type="button"
            className="win-btn win-max"
            aria-label={t("titlebar.maximize")}
          />
          <button
            type="button"
            className="win-btn win-close"
            aria-label={t("titlebar.close")}
          />
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-tabs">
            {(
              [
                ["assets", "sidebar.tabAssets"],
                ["scene", "sidebar.tabScene"],
                ["export", "sidebar.tabExport"],
              ] as const
            ).map(([id, key]) => (
              <button
                key={id}
                type="button"
                className={`stab ${tab === id ? "active" : ""}`}
                onClick={() => setTab(id)}
              >
                {t(key)}
              </button>
            ))}
          </div>

          <div className="sidebar-section">{t("sidebar.upload")}</div>

          <div
            className={`drop-zone ${dragOver ? "drag-over" : ""}`}
            role="button"
            tabIndex={0}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={onImportClick}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onImportClick();
            }}
          >
            <span className="drop-icon">⬆</span>
            <span className="drop-label">{t("sidebar.dropLabel")}</span>
            <span className="drop-hint">{t("sidebar.dropHint")}</span>
          </div>

          {importMsg ? (
            <div className="import-hint import-hint--error">{importMsg}</div>
          ) : null}

          <div className="sidebar-section">{t("sidebar.sequence")}</div>

          <div className="sequence-tabs">
            <button
              type="button"
              className={`seq-tab ${sequencePanelTab === "loaded" ? "active" : ""}`}
              onClick={() => setSequencePanelTab("loaded")}
            >
              {t("sidebar.loaded")}
            </button>
            <button
              type="button"
              className={`seq-tab ${sequencePanelTab === "library" ? "active" : ""}`}
              onClick={() => setSequencePanelTab("library")}
            >
              {t("sidebar.library")}
            </button>
          </div>

          <div className="asset-list">
            {sequencePanelTab === "loaded" ? (
              assets.length === 0 ? (
                <div className="asset-empty">{t("sidebar.emptyLoaded")}</div>
              ) : (
                assets.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`asset-item ${isUserSelected(a.id) ? "active" : ""}`}
                    onClick={() =>
                      selectTimelineClip({ asset: a, source: "user" })
                    }
                    onMouseEnter={() => {
                      if (a.root && !a.parseError) {
                        setPreviewHover({ kind: "user", id: a.id });
                      }
                    }}
                    onMouseLeave={() => setPreviewHover(null)}
                    onFocus={() => {
                      if (a.root && !a.parseError) {
                        setPreviewHover({ kind: "user", id: a.id });
                      }
                    }}
                    onBlur={() => setPreviewHover(null)}
                  >
                    <div className="asset-thumb">{a.icon}</div>
                    <div className="asset-info">
                      <div className="asset-name">{a.name}</div>
                      <div className="asset-meta">
                        {a.loading
                          ? t("sidebar.loading")
                          : a.parseError
                            ? t("sidebar.error")
                            : a.format}
                      </div>
                    </div>
                    <span className="asset-dur">
                      {a.loading ? "…" : formatDuration(a.durationSec)}
                    </span>
                  </button>
                ))
              )
            ) : LIBRARY_ITEMS.length === 0 ? (
              <div className="asset-empty">{t("sidebar.libraryHint")}</div>
            ) : (
              LIBRARY_ITEMS.map((entry) => {
                const cached = libraryCache[entry.id];
                const active = isLibrarySelected(entry.id);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={`asset-item ${active ? "active" : ""}`}
                    onClick={() => {
                      const cached = libraryCache[entry.id];
                      if (cached?.root && !cached.parseError) {
                        selectTimelineClip({
                          asset: cached,
                          source: "library",
                          libraryEntryId: entry.id,
                        });
                      } else {
                        void loadLibraryEntry(entry);
                      }
                    }}
                    onMouseEnter={() => {
                      const c = libraryCache[entry.id];
                      if (c?.root && !c.parseError) {
                        setPreviewHover({
                          kind: "library",
                          entryId: entry.id,
                        });
                      }
                    }}
                    onMouseLeave={() => setPreviewHover(null)}
                    onFocus={() => {
                      const c = libraryCache[entry.id];
                      if (c?.root && !c.parseError) {
                        setPreviewHover({
                          kind: "library",
                          entryId: entry.id,
                        });
                      }
                    }}
                    onBlur={() => setPreviewHover(null)}
                  >
                    <div className="asset-thumb">{iconForFormat(entry.format)}</div>
                    <div className="asset-info">
                      <div className="asset-name">{entry.name}</div>
                      <div className="asset-meta">
                        {!cached
                          ? t("sidebar.example")
                          : cached.loading
                            ? t("sidebar.loading")
                            : cached.parseError
                              ? t("sidebar.error")
                              : entry.format}
                      </div>
                    </div>
                    <span className="asset-dur">
                      {!cached || cached.loading
                        ? "…"
                        : formatDuration(cached.durationSec)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <div className="viewer-area">
          <div className="viewer-topbar">
            <span className="view-label active">{t("viewer.viewport")}</span>
            <span className="view-label" style={{ marginLeft: 8 }}>
              {t("viewer.camera")}
            </span>
            <div className="vtb-spacer" />
            <span className="vtb-info">
              {t("viewer.seq")} <span>{clipCountLabel}</span>
            </span>
            <span className="vtb-info" style={{ marginLeft: 12 }}>
              {t("viewer.total")}{" "}
              <span>{formatDuration(totalDuration)}</span>
            </span>
            <span className="vtb-info" style={{ marginLeft: 12 }}>
              {t("viewer.engineEEVEE")}
            </span>
          </div>

          <div className="viewport">
            <div className="viewport-bg" />
            <div className="viewport-grid" />

            <div className="viewport-overlay">
              <button type="button" className="ov-btn">
                <div className="ov-dot green" /> {t("viewer.overlayMagic")}
              </button>
              <button type="button" className="ov-btn">
                <div className="ov-dot amber" /> {t("viewer.overlayTime")}
              </button>
              <button type="button" className="ov-btn">
                <div className="ov-dot off" /> {t("viewer.overlayBg")}
              </button>
            </div>

            <div className="scene-container">
              <div
                className={`scene-frame ${isViewportPreview ? "scene-frame--preview" : ""}`}
              >
                <div className="corner corner-tl" />
                <div className="corner corner-tr" />
                <div className="corner corner-bl" />
                <div className="corner corner-br" />
                <span
                  className={`scene-label ${isViewportPreview ? "scene-label--preview" : ""}`}
                >
                  {isViewportPreview ? (
                    <>
                      <span className="scene-preview-name">
                        {previewAsset?.name}
                      </span>
                      <span className="scene-preview-badge">
                        {t("viewer.preview")}
                      </span>
                    </>
                  ) : (
                    selected?.name ?? t("viewer.noSelection")
                  )}
                </span>

                <Viewport3D
                  ref={viewportRef}
                  model={viewportModel}
                  animationTimeSec={viewportAnimationTime}
                  cameraPreset={viewportCameraContext.preset}
                  cameraPhaseU={viewportCameraContext.u}
                  isPlayingSequence={isPlaying}
                />

                {!viewportModel && !selected?.loading && !previewAsset?.loading ? (
                  <>
                    <div className="figure">
                      <div className="figure-head" />
                      <div className="figure-body" />
                      <div className="figure-shadow" />
                    </div>
                    <div className="floor-grid">
                      <div className="floor-line" />
                      <div className="floor-line" />
                      <div className="floor-line" />
                    </div>
                  </>
                ) : null}

                <span className="scene-timecode">{sceneLocalTimecode}</span>
              </div>
            </div>
          </div>

          <div className="playback-bar">
            <div className="pb-transport">
              <button
                type="button"
                className="pb-btn"
                title={t("playback.start")}
                disabled={totalDuration <= 0}
                onClick={seekSequenceStart}
              >
                ⏮
              </button>
              <button
                type="button"
                className="pb-btn"
                title={t("playback.prevFrame")}
                disabled={totalDuration <= 0}
                onClick={stepPrevFrame}
              >
                ◀
              </button>
              <button
                type="button"
                className="pb-btn play"
                title={t("playback.playPause")}
                disabled={totalDuration <= 0}
                onClick={togglePlay}
              >
                {isPlaying ? "⏸" : "▶"}
              </button>
              <button
                type="button"
                className="pb-btn"
                title={t("playback.nextFrame")}
                disabled={totalDuration <= 0}
                onClick={stepNextFrame}
              >
                &gt;
              </button>
              <button
                type="button"
                className="pb-btn"
                title={t("playback.end")}
                disabled={totalDuration <= 0}
                onClick={seekSequenceEnd}
              >
                ⏭
              </button>
              <button
                type="button"
                className={`pb-btn ${loopSequence ? "pb-btn--active" : ""}`}
                title={t("playback.loop")}
                aria-pressed={loopSequence}
                disabled={totalDuration <= 0}
                style={{ marginLeft: 4 }}
                onClick={() => setLoopSequence((v) => !v)}
              >
                ⟳
              </button>
            </div>

            <div
              className="pb-track"
              role="slider"
              aria-valuemin={0}
              aria-valuemax={Math.max(0, totalDuration)}
              aria-valuenow={sequenceTimeSec}
              aria-disabled={totalDuration <= 0}
              onPointerDown={onTrackPointerDown}
            >
              <div
                className="pb-progress"
                style={{ width: `${playheadPct}%` }}
              />
            </div>

            <span className="pb-time">
              <span>{formatTimecode(sequenceTimeSec, SEQUENCE_FPS)}</span>
              {" / "}
              {formatTimecode(totalDuration, SEQUENCE_FPS)}
            </span>

            <div className="pb-extra">
              <div className="pb-fps">
                <span>{activePlaybackFps}</span> fps
              </div>
              <button
                type="button"
                className="pb-btn"
                title={t("playback.render")}
                disabled={totalDuration <= 0 || exportBusy}
                aria-busy={exportBusy}
                onClick={() => void handleExportVideo()}
              >
                ⬛
              </button>
            </div>
          </div>

          <div className="timeline-area timeline-area--strip">
            <div className="tl-strip-head">
              <span className="tl-strip-title">{t("timeline.title")}</span>
              <span className="tl-strip-meta">
                {timelineRows.length === 0
                  ? t("timeline.emptyMeta")
                  : t("timeline.meta", {
                      count: timelineRows.length,
                      duration: formatDuration(totalDuration),
                    })}
              </span>
            </div>
            <div className="tl-strip-scroll">
              {timelineRows.length === 0 ? (
                <div className="tl-empty tl-empty--strip">
                  {t("timeline.emptyHint")}
                </div>
              ) : (
                <div className="tl-strip" role="list">
                  {timelineRows.map((clip) => {
                    const row = clip.asset;
                    const selectedThumb = isTimelineClipSelected(
                      clip,
                      selection
                    );
                    const stateClass = row.loading
                      ? "tl-thumb--loading"
                      : row.parseError
                        ? "tl-thumb--error"
                        : "";
                    return (
                      <div
                        key={`${clip.source}-${row.id}`}
                        className="tl-thumb-cell"
                        role="listitem"
                        onMouseEnter={() => {
                          if (row.root && !row.parseError) {
                            setPreviewHover(selectionFromClip(clip));
                          }
                        }}
                        onMouseLeave={() => setPreviewHover(null)}
                      >
                        <button
                          type="button"
                          className={[
                            "tl-thumb",
                            thumbClassForFormat(row.format),
                            stateClass,
                            selectedThumb ? "tl-thumb--selected" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          title={`${row.name} · ${formatShortLabel(row.format)}`}
                          aria-label={t("timeline.thumbSelect", {
                            name: row.name,
                          })}
                          aria-pressed={selectedThumb}
                          onClick={() => selectTimelineClip(clip)}
                        >
                          <span className="tl-thumb-main">
                            <span className="tl-thumb-ext">
                              {formatShortLabel(row.format)}
                            </span>
                            <span className="tl-thumb-glyph" aria-hidden>
                              {row.loading
                                ? "…"
                                : row.parseError
                                  ? "!"
                                  : row.icon}
                            </span>
                          </span>
                          <span className="tl-thumb-name" title={row.name}>
                            {row.name}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="tl-thumb-delete"
                          title={t("timeline.remove")}
                          aria-label={t("timeline.removeAria", { name: row.name })}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            deleteTimelineClip(clip);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className="right-panel">
          <div className="rp-section">
            <div className="rp-label">{t("clip.info")}</div>
            {selected ? (
              <>
                <div className="rp-row">
                  <span className="rp-key">{t("clip.file")}</span>
                  <span className="rp-val">{selected.name}</span>
                </div>
                <div className="rp-row">
                  <span className="rp-key">{t("clip.format")}</span>
                  <span className={`rp-val ${formatNeon ? "neon" : ""}`}>
                    {selected.format}
                  </span>
                </div>
                <div className="rp-row">
                  <span className="rp-key">{t("clip.size")}</span>
                  <span className="rp-val">{formatBytes(selected.fileSize)}</span>
                </div>
                <div className="rp-row">
                  <span className="rp-key">{t("clip.duration")}</span>
                  <span className="rp-val">
                    {formatDuration(selected.durationSec)}
                  </span>
                </div>
                {selectedTimelineClip ? (
                  <div className="rp-row rp-row--stack">
                    <span className="rp-key">{t("clip.camera.label")}</span>
                    <select
                      className="rp-select"
                      value={
                        clipCameraPresets[
                          timelineClipKey(selectedTimelineClip)
                        ] ?? "default"
                      }
                      onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                        const id = e.target.value as CameraPresetId;
                        const k = timelineClipKey(selectedTimelineClip);
                        setClipCameraPresets((prev) => ({
                          ...prev,
                          [k]: id,
                        }));
                      }}
                    >
                      {CAMERA_PRESET_IDS.map((id) => (
                        <option key={id} value={id}>
                          {t(`clip.camera.${id}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <div className="rp-row">
                  <span className="rp-key">{t("clip.frames")}</span>
                  <span className="rp-val">{selected.frames}</span>
                </div>
                <div className="rp-row">
                  <span className="rp-key">{t("clip.bones")}</span>
                  <span className="rp-val amber">{selected.bones}</span>
                </div>
                {selected.parseError ? (
                  <div className="rp-parse-error">{selected.parseError}</div>
                ) : null}
              </>
            ) : (
              <div className="rp-empty">{t("clip.none")}</div>
            )}
          </div>

          <div className="rp-section">
            <div className="rp-label">{t("render.title")}</div>
            <div className="rp-row">
              <span className="rp-key">{t("render.engine")}</span>
              <span className="rp-val neon">EEVEE</span>
            </div>
            <div className="rp-row">
              <span className="rp-key">{t("render.res")}</span>
              <span className="rp-val">1920×1080</span>
            </div>
            <div className="rp-row">
              <span className="rp-key">{t("render.shadows")}</span>
              <button
                type="button"
                className={`toggle ${renderOpts.shadows ? "on" : ""}`}
                onClick={() =>
                  setRenderOpts((o) => ({ ...o, shadows: !o.shadows }))
                }
                aria-pressed={renderOpts.shadows}
              />
            </div>
            <div className="rp-row">
              <span className="rp-key">{t("render.motionBlur")}</span>
              <button
                type="button"
                className={`toggle ${renderOpts.motionBlur ? "on" : ""}`}
                onClick={() =>
                  setRenderOpts((o) => ({ ...o, motionBlur: !o.motionBlur }))
                }
                aria-pressed={renderOpts.motionBlur}
              />
            </div>
            <div className="rp-row">
              <span className="rp-key">{t("render.background")}</span>
              <button
                type="button"
                className={`toggle ${renderOpts.background ? "on" : ""}`}
                onClick={() =>
                  setRenderOpts((o) => ({ ...o, background: !o.background }))
                }
                aria-pressed={renderOpts.background}
              />
            </div>
          </div>

          <div className="rp-section gen-ai-section">
            <div className="rp-label">{t("genai.sectionTitle")}</div>
            <div className="gen-ai-file-row">
              <span className="gen-ai-file-key">{t("genai.selectedFileLabel")}</span>
              <span
                className="gen-ai-file-val"
                title={genAiSelectedPath ?? undefined}
              >
                {genAiSelectedName ?? t("genai.noFileSelected")}
              </span>
            </div>

            {comfySettings ? (
              <>
                <div className="gen-ai-comfy-block">
                  <label className="gen-ai-file-key" htmlFor="gen-ai-comfy-url">
                    {t("genai.comfyBaseUrl")}
                  </label>
                  <input
                    id="gen-ai-comfy-url"
                    className="gen-ai-inline-input"
                    type="url"
                    spellCheck={false}
                    value={comfySettings.baseUrl}
                    onChange={(e) =>
                      setComfySettings((prev) =>
                        prev ? { ...prev, baseUrl: e.target.value } : prev
                      )
                    }
                    onBlur={() => {
                      persistComfyFromRef();
                    }}
                  />
                </div>
                <div className="gen-ai-comfy-block">
                  <span className="gen-ai-file-key">{t("genai.comfyWorkflow")}</span>
                  <div className="gen-ai-workflow-row">
                    <button
                      type="button"
                      className="gen-ai-workflow-pick"
                      onClick={() => void handlePickComfyWorkflow()}
                    >
                      {t("genai.comfyPickWorkflow")}
                    </button>
                    <span
                      className="gen-ai-file-val gen-ai-workflow-path"
                      title={comfySettings.workflowApiPath || undefined}
                    >
                      {comfySettings.workflowApiPath
                        ? fileBasename(comfySettings.workflowApiPath)
                        : t("genai.comfyNoWorkflow")}
                    </span>
                  </div>
                </div>
                <div className="gen-ai-comfy-grid">
                  <div className="gen-ai-comfy-block">
                    <label
                      className="gen-ai-file-key"
                      htmlFor="gen-ai-video-node"
                    >
                      {t("genai.comfyVideoNode")}
                    </label>
                    <input
                      id="gen-ai-video-node"
                      className="gen-ai-inline-input"
                      spellCheck={false}
                      placeholder={t("genai.comfyNodePlaceholder")}
                      value={comfySettings.injection.videoNodeId}
                      onChange={(e) =>
                        setComfySettings((prev) =>
                          prev
                            ? {
                                ...prev,
                                injection: {
                                  ...prev.injection,
                                  videoNodeId: e.target.value,
                                },
                              }
                            : prev
                        )
                      }
                      onBlur={persistComfyFromRef}
                    />
                  </div>
                  <div className="gen-ai-comfy-block">
                    <label
                      className="gen-ai-file-key"
                      htmlFor="gen-ai-prompt-node"
                    >
                      {t("genai.comfyPromptNode")}
                    </label>
                    <input
                      id="gen-ai-prompt-node"
                      className="gen-ai-inline-input"
                      spellCheck={false}
                      placeholder={t("genai.comfyNodePlaceholder")}
                      value={comfySettings.injection.promptNodeId}
                      onChange={(e) =>
                        setComfySettings((prev) =>
                          prev
                            ? {
                                ...prev,
                                injection: {
                                  ...prev.injection,
                                  promptNodeId: e.target.value,
                                },
                              }
                            : prev
                        )
                      }
                      onBlur={persistComfyFromRef}
                    />
                  </div>
                </div>
                <div className="gen-ai-comfy-grid">
                  <div className="gen-ai-comfy-block">
                    <label
                      className="gen-ai-file-key"
                      htmlFor="gen-ai-video-input-key"
                    >
                      {t("genai.comfyVideoInputKey")}
                    </label>
                    <input
                      id="gen-ai-video-input-key"
                      className="gen-ai-inline-input"
                      spellCheck={false}
                      value={comfySettings.injection.videoInputKey}
                      onChange={(e) =>
                        setComfySettings((prev) =>
                          prev
                            ? {
                                ...prev,
                                injection: {
                                  ...prev.injection,
                                  videoInputKey: e.target.value,
                                },
                              }
                            : prev
                        )
                      }
                      onBlur={persistComfyFromRef}
                    />
                  </div>
                  <div className="gen-ai-comfy-block">
                    <label
                      className="gen-ai-file-key"
                      htmlFor="gen-ai-prompt-input-key"
                    >
                      {t("genai.comfyPromptInputKey")}
                    </label>
                    <input
                      id="gen-ai-prompt-input-key"
                      className="gen-ai-inline-input"
                      spellCheck={false}
                      value={comfySettings.injection.promptInputKey}
                      onChange={(e) =>
                        setComfySettings((prev) =>
                          prev
                            ? {
                                ...prev,
                                injection: {
                                  ...prev.injection,
                                  promptInputKey: e.target.value,
                                },
                              }
                            : prev
                        )
                      }
                      onBlur={persistComfyFromRef}
                    />
                  </div>
                </div>
              </>
            ) : null}

            <div className="gen-ai-prompt-head">
              <label
                className="gen-ai-prompt-label"
                htmlFor="gen-ai-prompt"
              >
                {t("genai.promptLabel")}
              </label>
              <button
                type="button"
                className="gen-ai-prompt-expand"
                title={t("genai.expandPrompt")}
                aria-label={t("genai.expandPromptAria")}
                onClick={() => setGenAiPromptModalOpen(true)}
              >
                ⛶
              </button>
            </div>
            <textarea
              id="gen-ai-prompt"
              className="gen-ai-prompt"
              value={genAiPrompt}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                setGenAiPrompt(e.target.value)
              }
              rows={4}
              placeholder={t("genai.promptPlaceholder")}
              spellCheck={false}
            />
            {genAiComfyError ? (
              <p className="gen-ai-error" role="alert">
                {genAiComfyError}
              </p>
            ) : null}
            <button
              type="button"
              className="gen-ai-btn"
              disabled={genAiComfyBusy}
              aria-busy={genAiComfyBusy}
              onClick={() => void handleGenAiComfy()}
            >
              <span className="gen-ai-icon">✦</span>
              <span className="gen-ai-label">
                {genAiComfyBusy ? t("genai.generating") : t("genai.generate")}
              </span>
              <span className="gen-ai-sub">
                {genAiComfyBusy ? t("genai.busySub") : t("genai.sub")}
              </span>
            </button>
          </div>

          <div className="oq-wrap">
            <div className="oq-head">
              <div className="rp-label">{t("outputQueue.title")}</div>
              <button
                type="button"
                className="oq-refresh"
                title={t("outputQueue.refresh")}
                onClick={() => void loadOutputQueue()}
              >
                ↻
              </button>
            </div>

            <div className="oq-preview">
              {exportedVideos.length === 0 ? (
                <div className="oq-preview-placeholder">
                  {t("outputQueue.empty")}
                </div>
              ) : outputQueuePreviewPath && !outputQueuePreviewUrl ? (
                <div className="oq-preview-loading">
                  {t("outputQueue.previewLoading")}
                </div>
              ) : outputQueuePreviewUrl ? (
                <video
                  key={outputQueuePreviewPath ?? "preview"}
                  className="oq-preview-video"
                  src={outputQueuePreviewUrl}
                  controls
                  playsInline
                  preload="metadata"
                  onLoadedData={(e) => {
                    void e.currentTarget.play().catch(() => {});
                  }}
                />
              ) : (
                <div className="oq-preview-placeholder">
                  {t("outputQueue.previewPlaceholder")}
                </div>
              )}
            </div>

            <div className="oq-list" role="list">
              {exportedVideos.length === 0 ? (
                <div className="oq-empty">{t("outputQueue.empty")}</div>
              ) : (
                exportedVideos.map((v) => (
                  <div
                    key={v.fullPath}
                    className="oq-item-row"
                    role="listitem"
                  >
                    <button
                      type="button"
                      className={`oq-item ${
                        outputQueuePreviewPath === v.fullPath
                          ? "oq-item--active"
                          : ""
                      }`}
                      title={v.name}
                      onClick={() =>
                        setOutputQueuePreviewPath(v.fullPath)
                      }
                    >
                      <span className="oq-item-name">{v.name}</span>
                      <span className="oq-item-date">
                        {new Date(v.mtimeMs).toLocaleString(i18n.language, {
                          dateStyle: "short",
                          timeStyle: "short",
                        })}
                      </span>
                    </button>
                    <div className="oq-item-actions">
                      <button
                        type="button"
                        className={`oq-item-gen ${
                          genAiSelectedPath === v.fullPath
                            ? "oq-item-gen--on"
                            : ""
                        }`}
                        title={
                          genAiSelectedPath === v.fullPath
                            ? t("outputQueue.deselectGenAria")
                            : t("outputQueue.selectGenAria")
                        }
                        aria-label={
                          genAiSelectedPath === v.fullPath
                            ? t("outputQueue.deselectGenAria")
                            : t("outputQueue.selectGenAria")
                        }
                        aria-pressed={genAiSelectedPath === v.fullPath}
                        onClick={() => toggleGenAiSelection(v.fullPath)}
                      >
                        ✦
                      </button>
                      <button
                        type="button"
                        className="oq-item-open"
                        title={t("outputQueue.openAria")}
                        aria-label={t("outputQueue.openAria")}
                        onClick={() => void openVideoInExplorer(v.fullPath)}
                      >
                        ↗
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>
      </div>

      <footer className="statusbar">
        <div className="sb-item">
          <div className="sb-dot green" />
          {t("status.blender")}
        </div>
        <div className="sb-item">
          <div className="sb-dot green" />
          {t("status.ffmpeg")}
        </div>
        <div className="sb-item">
          {t("status.loadedLibrary", {
            loaded: assets.length,
            library: Object.values(libraryCache).filter(
              (a) => a.root && !a.parseError
            ).length,
          })}
        </div>
        <div className="sb-spacer" />
        <div className="sb-item">{t("status.gpu")}</div>
        <div className="sb-item">
          <div className="sb-dot amber" />
          {t("status.renderIdle")}
        </div>
        <div className="sb-item">{t("status.version")}</div>
      </footer>

      {genAiPromptModalOpen ? (
        <div
          className="gen-ai-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setGenAiPromptModalOpen(false);
          }}
        >
          <div
            className="gen-ai-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gen-ai-modal-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="gen-ai-modal-header">
              <h2 id="gen-ai-modal-title" className="gen-ai-modal-title">
                {t("genai.promptModalTitle")}
              </h2>
              <button
                type="button"
                className="gen-ai-modal-close"
                aria-label={t("genai.closeModal")}
                title={t("genai.closeModal")}
                onClick={() => setGenAiPromptModalOpen(false)}
              >
                ×
              </button>
            </div>
            <textarea
              ref={genAiModalTextareaRef}
              id="gen-ai-prompt-modal-field"
              className="gen-ai-modal-textarea"
              value={genAiPrompt}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                setGenAiPrompt(e.target.value)
              }
              placeholder={t("genai.promptPlaceholder")}
              spellCheck={false}
            />
            <div className="gen-ai-modal-footer">
              <button
                type="button"
                className="gen-ai-modal-done"
                onClick={() => setGenAiPromptModalOpen(false)}
              >
                {t("genai.closeModal")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {exportSuccessToast ? (
        <div
          className="export-toast export-toast--success"
          role="status"
          aria-live="polite"
        >
          <div className="export-toast-inner">
            <p className="export-toast-title">
              {t(
                exportSuccessKind === "genai"
                  ? "genai.doneToastTitle"
                  : "exportVideo.doneToastTitle"
              )}
            </p>
            <button
              type="button"
              className="export-toast-path"
              title={t("exportVideo.openInExplorer")}
              onClick={() => void openVideoInExplorer(exportSuccessToast)}
            >
              {exportSuccessToast}
            </button>
            <div className="export-toast-actions">
              <button
                type="button"
                className="export-toast-btn export-toast-btn--copy"
                onClick={() => void copyExportSuccessPath()}
              >
                {t("exportVideo.copyPath")}
              </button>
              <button
                type="button"
                className="export-toast-btn export-toast-btn--close"
                onClick={dismissExportSuccessToast}
                aria-label={t("exportVideo.closeToast")}
              >
                ×
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {exportErrorToast ? (
        <div
          className="export-toast export-toast--error"
          role="alert"
          aria-live="assertive"
        >
          <div className="export-toast-inner">
            <p className="export-toast-text">{exportErrorToast}</p>
            <div className="export-toast-actions">
              <button
                type="button"
                className="export-toast-btn export-toast-btn--copy"
                onClick={() => void copyExportErrorToast()}
              >
                {t("exportVideo.copyError")}
              </button>
              <button
                type="button"
                className="export-toast-btn export-toast-btn--close"
                onClick={dismissExportErrorToast}
                aria-label={t("exportVideo.closeToast")}
              >
                ×
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
