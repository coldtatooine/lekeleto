import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import {
  AmbientLight,
  AnimationClip,
  AnimationMixer,
  DirectionalLight,
  Group,
  Object3D,
  PerspectiveCamera,
  Scene,
  Spherical,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  applyCameraPresetToOrbit,
  applyHandcamElasticShake,
  applyHandcamShake,
  sphericalOffsetFromCamera,
  type CameraPresetId,
} from "../lib/cameraPresets";
import { frameBounds } from "../lib/modelLoader";

function pickPrimaryClip(anims: AnimationClip[]): AnimationClip | null {
  if (anims.length === 0) return null;
  const withTracks = anims.filter((c) => c.tracks.length > 0);
  const pool = withTracks.length > 0 ? withTracks : anims;
  return pool.reduce((best, c) => {
    if (c.duration > best.duration) return c;
    if (c.duration === best.duration && c.tracks.length > best.tracks.length)
      return c;
    return best;
  });
}

export type CaptureFrameParams = {
  model: Object3D | null;
  animationLocalTimeSec: number;
  cameraPreset: CameraPresetId;
  cameraPhaseU: number;
  /** Tempo global na sequência (s) — shake handcam determinístico no export. */
  sequenceTimeSec: number;
  width: number;
  height: number;
  opaqueBackground: boolean;
};

export type Viewport3DHandle = {
  captureFrame: (params: CaptureFrameParams) => Promise<ArrayBuffer>;
  /** Repõe o modelo da cena após export (mesmo fluxo do useEffect). */
  syncToModel: (model: Object3D | null, animationTimeSec: number) => void;
};

type Props = {
  model: Object3D | null;
  /** Tempo local da animação (s), alinhado ao clip na sequência. */
  animationTimeSec: number;
  cameraPreset: CameraPresetId;
  cameraPhaseU: number;
  isPlayingSequence?: boolean;
};

export const Viewport3D = forwardRef<Viewport3DHandle, Props>(
  function Viewport3D(
    {
      model,
      animationTimeSec,
      cameraPreset,
      cameraPhaseU,
      isPlayingSequence = false,
    },
    ref
  ) {
    const mountRef = useRef<HTMLDivElement>(null);
    const modelGroupRef = useRef<Group | null>(null);
    const sceneRef = useRef<Scene | null>(null);
    const cameraRef = useRef<PerspectiveCamera | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const rendererRef = useRef<WebGLRenderer | null>(null);
    const mixerRef = useRef<AnimationMixer | null>(null);
    const clipDurationRef = useRef(0);
    const animationTimeRef = useRef(0);
    const baseSphericalRef = useRef<Spherical | null>(null);
    const orbitTargetRef = useRef<Vector3 | null>(null);
    const cameraPresetRef = useRef<CameraPresetId>("default");
    const cameraPhaseRef = useRef(0);
    const isPlayingSequenceRef = useRef(false);

    const applyModelToScene = useCallback((
      nextModel: Object3D | null,
      initialAnimTime: number
    ) => {
      const group = modelGroupRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!group || !camera || !controls) return;

      while (group.children.length) {
        group.remove(group.children[0]);
      }

      mixerRef.current = null;
      clipDurationRef.current = 0;

      if (!nextModel) {
        baseSphericalRef.current = null;
        orbitTargetRef.current = null;
        camera.position.set(3, 2.5, 4);
        camera.lookAt(0, 0.9, 0);
        controls.target.set(0, 0.9, 0);
        controls.update();
        return;
      }

      group.add(nextModel);

      const anims = nextModel.animations?.length ? nextModel.animations : [];
      const clip = pickPrimaryClip(anims);
      if (clip) {
        clip.resetDuration();
      }
      if (clip && clip.tracks.length > 0 && clip.duration > 0) {
        const mixer = new AnimationMixer(nextModel);
        mixerRef.current = mixer;
        clipDurationRef.current = clip.duration;
        const action = mixer.clipAction(clip);
        action.play();
        action.clampWhenFinished = false;
        mixer.setTime(
          Math.min(Math.max(0, initialAnimTime), clip.duration)
        );
      }

      const box = frameBounds(nextModel);
      const center = box.getCenter(new Vector3());
      const maxDim = Math.max(
        box.max.x - box.min.x,
        box.max.y - box.min.y,
        box.max.z - box.min.z,
        0.001
      );
      const dist = maxDim * 2.2;
      camera.position.set(
        center.x + dist * 0.65,
        center.y + dist * 0.45,
        center.z + dist * 0.65
      );
      camera.lookAt(center);
      const target = new Vector3().copy(center);
      controls.target.copy(target);
      orbitTargetRef.current = target;
      baseSphericalRef.current = sphericalOffsetFromCamera(
        camera,
        target,
        new Spherical()
      );
      controls.update();
    }, []);

    useLayoutEffect(() => {
      const mount = mountRef.current;
      if (!mount) return;

      const scene = new Scene();
      sceneRef.current = scene;
      const camera = new PerspectiveCamera(45, 1, 0.1, 5000);
      cameraRef.current = camera;

      const renderer = new WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
      });
      rendererRef.current = renderer;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x0a0f16, 0.35);
      renderer.domElement.style.display = "block";
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      mount.appendChild(renderer.domElement);

      const ambient = new AmbientLight(0xb8c8d8, 0.45);
      const dir = new DirectionalLight(0xffffff, 0.85);
      dir.position.set(2.2, 4.5, 3);
      scene.add(ambient, dir);

      const modelGroup = new Group();
      scene.add(modelGroup);
      modelGroupRef.current = modelGroup;

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controlsRef.current = controls;

      let raf = 0;
      const tick = () => {
        raf = requestAnimationFrame(tick);
        const mixer = mixerRef.current;
        const dur = clipDurationRef.current;
        if (mixer && dur > 0) {
          const t = Math.min(Math.max(0, animationTimeRef.current), dur);
          mixer.setTime(t);
        }
        const preset = cameraPresetRef.current;
        const u = cameraPhaseRef.current;
        const baseSph = baseSphericalRef.current;
        const target = orbitTargetRef.current;
        if (preset !== "default" && baseSph && target) {
          applyCameraPresetToOrbit(camera, controls, target, baseSph, preset, u);
          if (preset === "handcam" || preset === "handcamElastic") {
            const shakePhaseSec = isPlayingSequenceRef.current
              ? performance.now() / 1000
              : animationTimeRef.current;
            if (preset === "handcam") {
              applyHandcamShake(camera, target, baseSph.radius, shakePhaseSec);
            } else {
              applyHandcamElasticShake(
                camera,
                target,
                baseSph.radius,
                shakePhaseSec
              );
            }
          }
        }
        controls.enableRotate = preset === "default";
        controls.enablePan = preset === "default";
        controls.enableZoom = preset === "default";
        controls.update();
        renderer.render(scene, camera);
      };
      tick();

      const resize = () => {
        const w = mount.clientWidth;
        const h = mount.clientHeight;
        if (w < 2 || h < 2) return;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
      };
      const ro = new ResizeObserver(resize);
      ro.observe(mount);
      resize();

      return () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        controls.dispose();
        renderer.dispose();
        while (modelGroup.children.length) {
          modelGroup.remove(modelGroup.children[0]);
        }
        scene.clear();
        sceneRef.current = null;
        modelGroupRef.current = null;
        cameraRef.current = null;
        controlsRef.current = null;
        rendererRef.current = null;
        mixerRef.current = null;
        clipDurationRef.current = 0;
        baseSphericalRef.current = null;
        orbitTargetRef.current = null;
        if (mount.contains(renderer.domElement)) {
          mount.removeChild(renderer.domElement);
        }
      };
    }, []);

    useEffect(() => {
      applyModelToScene(model, animationTimeSec);
    }, [model, applyModelToScene]);

    useEffect(() => {
      if (cameraPreset !== "default") return;
      const cam = cameraRef.current;
      const controls = controlsRef.current;
      const target = orbitTargetRef.current;
      const base = baseSphericalRef.current;
      if (!model || !cam || !controls || !target || !base) return;
      applyCameraPresetToOrbit(cam, controls, target, base, "default", 0);
      controls.update();
    }, [cameraPreset, model]);

    animationTimeRef.current = animationTimeSec;
    cameraPresetRef.current = cameraPreset;
    cameraPhaseRef.current = cameraPhaseU;
    isPlayingSequenceRef.current = isPlayingSequence;

    useImperativeHandle(
      ref,
      () => ({
        syncToModel: (nextModel, animTime) => {
          applyModelToScene(nextModel, animTime);
        },
        captureFrame: (params: CaptureFrameParams) => {
          const scene = sceneRef.current;
          const camera = cameraRef.current;
          const controls = controlsRef.current;
          const renderer = rendererRef.current;
          const group = modelGroupRef.current;
          if (!scene || !camera || !controls || !renderer || !group) {
            return Promise.reject(new Error("Viewport 3D não inicializado."));
          }

          const currentChild = group.children[0] ?? null;
          if (currentChild !== params.model) {
            applyModelToScene(params.model, params.animationLocalTimeSec);
          } else {
            const mixer = mixerRef.current;
            const dur = clipDurationRef.current;
            if (mixer && dur > 0) {
              mixer.setTime(
                Math.min(
                  Math.max(0, params.animationLocalTimeSec),
                  dur
                )
              );
            }
          }

          const preset = params.cameraPreset;
          const baseSph = baseSphericalRef.current;
          const target = orbitTargetRef.current;

          if (preset !== "default" && baseSph && target) {
            applyCameraPresetToOrbit(
              camera,
              controls,
              target,
              baseSph,
              preset,
              params.cameraPhaseU
            );
            if (preset === "handcam" || preset === "handcamElastic") {
              const shakeT = params.sequenceTimeSec;
              if (preset === "handcam") {
                applyHandcamShake(camera, target, baseSph.radius, shakeT);
              } else {
                applyHandcamElasticShake(
                  camera,
                  target,
                  baseSph.radius,
                  shakeT
                );
              }
            }
          } else if (preset === "default" && baseSph && target) {
            applyCameraPresetToOrbit(
              camera,
              controls,
              target,
              baseSph,
              "default",
              0
            );
          }

          controls.enableRotate = false;
          controls.enablePan = false;
          controls.enableZoom = false;
          controls.update();

          const prevPR = renderer.getPixelRatio();
          const { width, height, opaqueBackground } = params;
          renderer.setPixelRatio(1);
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          renderer.setClearColor(
            0x0a0f16,
            opaqueBackground ? 1 : 0.35
          );

          renderer.render(scene, camera);

          return new Promise<ArrayBuffer>((resolve, reject) => {
            renderer.domElement.toBlob(
              (blob) => {
                const mount = mountRef.current;
                if (mount) {
                  const w = mount.clientWidth;
                  const h = mount.clientHeight;
                  renderer.setPixelRatio(prevPR);
                  if (w >= 2 && h >= 2) {
                    renderer.setSize(w, h, false);
                    camera.aspect = w / h;
                    camera.updateProjectionMatrix();
                  }
                } else {
                  renderer.setPixelRatio(prevPR);
                }
                renderer.setClearColor(0x0a0f16, 0.35);
                if (!blob) {
                  reject(new Error("toBlob falhou."));
                  return;
                }
                void blob.arrayBuffer().then(resolve);
              },
              "image/png"
            );
          });
        },
      }),
      [applyModelToScene]
    );

    return <div ref={mountRef} className="viewport-three" />;
  }
);
