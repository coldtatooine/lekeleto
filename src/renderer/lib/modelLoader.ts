import {
  AnimationClip,
  Bone,
  Box3,
  Mesh,
  Object3D,
  SkinnedMesh,
  Vector3,
} from "three";
import { SEQUENCE_FPS } from "./sequencePlayback";
import { ColladaLoader } from "three/addons/loaders/ColladaLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export type AssetFormat = "COLLADA" | "FBX" | "GLB";

export function detectFormat(fileName: string): AssetFormat | null {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (ext === ".dae") return "COLLADA";
  if (ext === ".fbx") return "FBX";
  if (ext === ".glb") return "GLB";
  return null;
}

export function countBones(root: Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const b = o as Bone;
    if (b.isBone) n += 1;
  });
  if (n > 0) return n;
  let max = 0;
  root.traverse((o) => {
    const m = o as SkinnedMesh;
    if (m.isSkinnedMesh && m.skeleton?.bones) {
      max = Math.max(max, m.skeleton.bones.length);
    }
  });
  return max;
}

function clipDurationSeconds(clips: AnimationClip[]): number {
  if (clips.length === 0) return 0;
  let max = 0;
  for (const c of clips) {
    c.resetDuration();
    if (c.duration > max) max = c.duration;
  }
  return max;
}

/** Heurística: chaves por track vs duração do clip mais longo (não é o FPS real do DCC, mas evita 24 fixo para todos). */
export function estimatePlaybackFps(clips: AnimationClip[]): number {
  if (clips.length === 0) return SEQUENCE_FPS;
  for (const c of clips) {
    c.resetDuration();
  }
  const longest = clips.reduce((a, b) => (a.duration >= b.duration ? a : b));
  if (longest.duration <= 0 || longest.tracks.length === 0) {
    return SEQUENCE_FPS;
  }
  let maxKeys = 0;
  for (const tr of longest.tracks) {
    const n = tr.times?.length ?? 0;
    if (n > maxKeys) maxKeys = n;
  }
  if (maxKeys < 2) return SEQUENCE_FPS;
  const fps = (maxKeys - 1) / longest.duration;
  return Math.min(120, Math.max(12, Math.round(fps)));
}

export type ParsedModel = {
  root: Object3D;
  clips: AnimationClip[];
  durationSec: number;
  bones: number;
  playbackFps: number;
};

export async function parseModelBuffer(
  buffer: ArrayBuffer,
  fileName: string
): Promise<ParsedModel> {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();

  if (ext === ".dae") {
    const loader = new ColladaLoader();
    const text = new TextDecoder("utf-8").decode(buffer);
    const collada = loader.parse(text, "");
    if (!collada?.scene) throw new Error("COLLADA inválido ou vazio");
    const root = collada.scene;
    const clips = root.animations ?? [];
    const durationSec = clipDurationSeconds(clips);
    return {
      root,
      clips,
      durationSec,
      bones: countBones(root),
      playbackFps: estimatePlaybackFps(clips),
    };
  }

  if (ext === ".fbx") {
    const loader = new FBXLoader();
    const root = loader.parse(buffer, "");
    const clips = root.animations ?? [];
    const durationSec = clipDurationSeconds(clips);
    return {
      root,
      clips,
      durationSec,
      bones: countBones(root),
      playbackFps: estimatePlaybackFps(clips),
    };
  }

  if (ext === ".glb") {
    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(buffer, "");
    const root = gltf.scene;
    const clips = gltf.animations ?? [];
    const durationSec = clipDurationSeconds(clips);
    return {
      root,
      clips,
      durationSec,
      bones: countBones(root),
      playbackFps: estimatePlaybackFps(clips),
    };
  }

  throw new Error(`Formato não suportado: ${ext}`);
}

export function disposeObject3D(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh | SkinnedMesh;
    if ((m as SkinnedMesh).isSkinnedMesh || m.isMesh) {
      m.geometry?.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    }
  });
}

export function frameBounds(root: Object3D): Box3 {
  const box = new Box3().setFromObject(root);
  if (!box.isEmpty()) return box;
  return new Box3().setFromCenterAndSize(new Vector3(0, 0, 0), new Vector3(1, 1, 1));
}
