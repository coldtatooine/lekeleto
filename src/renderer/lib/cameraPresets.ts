import { Spherical, Vector3 } from "three";
import type { PerspectiveCamera } from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";

export type CameraPresetId =
  | "default"
  | "tilt"
  | "dollyIn"
  | "dollyOut"
  | "highAngle"
  | "handcam"
  | "handcamElastic";

export const CAMERA_PRESET_IDS: CameraPresetId[] = [
  "default",
  "tilt",
  "dollyIn",
  "dollyOut",
  "highAngle",
  "handcam",
  "handcamElastic",
];

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * Interpola esfera (raio, polar, azimute) em torno do target ao longo do segmento (u ∈ [0,1]).
 * Base vem do enquadramento inicial (bounding box).
 */
function interpolateSpherical(
  base: Spherical,
  preset: CameraPresetId,
  u: number
): Spherical {
  const out = new Spherical().copy(base);
  const t = smoothstep(u);

  switch (preset) {
    case "default":
      return out;
    case "tilt": {
      const delta = 0.32;
      out.phi = base.phi + (t - 0.5) * 2 * delta;
      return out;
    }
    case "dollyIn": {
      out.radius = base.radius * (1.3 - 0.42 * t);
      return out;
    }
    case "dollyOut": {
      out.radius = base.radius * (0.88 + 0.52 * t);
      return out;
    }
    case "highAngle": {
      const phiTo = Math.min(base.phi * 0.52, Math.PI / 2 - 0.1);
      out.phi = base.phi + (phiTo - base.phi) * t;
      return out;
    }
    case "handcam":
    case "handcamElastic":
      return out;
    default:
      return out;
  }
}

const _shakeScratch = new Vector3();

/** Onda quadrada (−1 / +1) — transições bruscas em vez de senoides suaves. */
function sq(t: number): number {
  return Math.sin(t) >= 0 ? 1 : -1;
}

/** Passo discreto por eixo (mudança seca em intervalos curtos). */
function stepFlip(t: number, hz: number, phase: number): number {
  return (Math.floor(t * hz + phase) & 1) ? 1 : -1;
}

/**
 * Handcam dramático: amplitude alta + camadas quadradas e flips discretos por eixo.
 */
export function applyHandcamShake(
  camera: PerspectiveCamera,
  target: Vector3,
  baseRadius: number,
  timeSec: number
): void {
  const r = Math.max(baseRadius, 0.001);
  const a = r * 0.058;
  const t = timeSec;

  const ox =
    sq(t * 5.9 + 0.4) * a * 1.0 +
    sq(t * 13.7 + 2.2) * a * 0.62 +
    sq(t * 29.1 + 0.8) * a * 0.45 +
    stepFlip(t, 4.1, 0.1) * a * 0.42 +
    stepFlip(t, 9.3, 0.55) * a * 0.28;

  const oy =
    sq(t * 6.8 + 1.3) * a * 1.05 +
    sq(t * 16.2 + 0.1) * a * 0.58 +
    sq(t * 23.4 + 1.9) * a * 0.4 +
    stepFlip(t, 3.6, 0.35) * a * 0.48 +
    stepFlip(t, 11.2, 0.2) * a * 0.33;

  const oz =
    sq(t * 7.4 + 0.2) * a * 0.82 +
    sq(t * 19.8 + 1.4) * a * 0.52 +
    sq(t * 27.5 + 0.6) * a * 0.38 +
    stepFlip(t, 4.7, 0.7) * a * 0.5 +
    stepFlip(t, 8.1, 0.05) * a * 0.36;

  _shakeScratch.set(ox, oy, oz);
  camera.position.add(_shakeScratch);
  camera.lookAt(target);
}

const _elasticScratch = new Vector3();

/**
 * Handcam elástico: arco longo no quadro.
 * φ ∈ [0,π]: esquerda → direita com arco para cima (semicírculo superior em X/Y).
 * φ ∈ [π,2π]: direita → esquerda com arco para baixo (semicírculo inferior).
 * x = −cos φ, y = sin φ — um círculo no plano da tela (mundo X/Y).
 * Picotado leve em Y por cima; Z respira em meia velocidade.
 */
export function applyHandcamElasticShake(
  camera: PerspectiveCamera,
  target: Vector3,
  baseRadius: number,
  timeSec: number
): void {
  const r = Math.max(baseRadius, 0.001);
  const t = timeSec;
  const w = 2.05;
  const phi = t * w;

  const ax = r * 0.128;
  const ay = r * 0.094;

  const arcX = -Math.cos(phi) * ax;
  const arcY = Math.sin(phi) * ay;

  const chopY =
    r *
    0.021 *
    (Math.sin(t * 11.2) * 0.55 +
      Math.sin(t * 17.5 + 0.5) * 0.38 +
      Math.sin(t * 24.1 + 1.0) * 0.24);

  const ox = arcX;
  const oy = arcY + chopY;

  const oz =
    r * 0.045 * Math.sin(phi * 0.52 + 0.6) +
    r * 0.018 * Math.sin(t * 2.05 + 0.3);

  _elasticScratch.set(ox, oy, oz);
  camera.position.add(_elasticScratch);
  camera.lookAt(target);
}

export function applyCameraPresetToOrbit(
  camera: PerspectiveCamera,
  controls: OrbitControls,
  target: Vector3,
  base: Spherical,
  preset: CameraPresetId,
  u: number
): void {
  const sph = interpolateSpherical(base, preset, u);
  sph.makeSafe();
  const offset = new Vector3().setFromSpherical(sph);
  camera.position.copy(target).add(offset);
  controls.target.copy(target);
  camera.lookAt(controls.target);
}

export function sphericalOffsetFromCamera(
  camera: PerspectiveCamera,
  target: Vector3,
  into: Spherical
): Spherical {
  const v = new Vector3().subVectors(camera.position, target);
  return into.setFromVector3(v);
}
