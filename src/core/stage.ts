import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { disposeObject } from './dispose';

/**
 * 모든 실험이 공유하는 무대.
 * 렌더러·카메라·컨트롤·라벨 렌더러·리사이즈·루프·정리를 한곳에서 책임진다.
 */
export interface Stage {
  root: HTMLElement;
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  clock: THREE.Timer;
  /** 매 프레임 호출. dt는 초 단위. */
  onFrame(cb: (dt: number, t: number) => void): void;
  /** 렌더 함수를 바꾼다(후처리 컴포저 등). */
  setRender(fn: () => void): void;
  onResize(cb: (w: number, h: number) => void): void;
  /** 캔버스 좌표 → NDC */
  toNdc(e: PointerEvent | MouseEvent): THREE.Vector2;
  dispose(): void;
}

export interface StageOptions {
  background?: number;
  fov?: number;
  shadows?: boolean;
  environment?: boolean;
}

export function createStage(root: HTMLElement, opts: StageOptions = {}): Stage {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  // 고해상도 모니터에서 픽셀 수가 4배로 늘어나는 것을 막기 위해 DPR 상한을 둔다.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  if (opts.shadows) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
  }
  root.appendChild(renderer.domElement);

  const labels = new CSS2DRenderer();
  labels.domElement.className = 'label-layer';
  root.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(opts.background ?? 0x0b1020);

  if (opts.environment !== false) {
    // PBR 재질은 환경광이 있어야 금속·유리 느낌이 산다. 외부 HDR 없이 RoomEnvironment로 충분하다.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  }

  const camera = new THREE.PerspectiveCamera(opts.fov ?? 45, 1, 0.1, 5000);
  camera.position.set(40, 30, 40);

  const controls = new OrbitControls(camera, labels.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495; // 바닥 아래로 내려가지 않는다.

  const clock = new THREE.Timer();
  const frameCbs: Array<(dt: number, t: number) => void> = [];
  const resizeCbs: Array<(w: number, h: number) => void> = [];
  let render = () => renderer.render(scene, camera);

  const resize = () => {
    const w = root.clientWidth;
    const h = root.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    labels.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    resizeCbs.forEach((cb) => cb(w, h));
  };
  const ro = new ResizeObserver(resize);
  ro.observe(root);
  resize();

  renderer.setAnimationLoop((time) => {
    clock.update(time);
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.getElapsed();
    controls.update(dt);
    frameCbs.forEach((cb) => cb(dt, t));
    render();
    labels.render(scene, camera);
  });

  const ndc = new THREE.Vector2();

  return {
    root,
    renderer,
    labels,
    scene,
    camera,
    controls,
    clock,
    onFrame: (cb) => frameCbs.push(cb),
    setRender: (fn) => (render = fn),
    onResize: (cb) => {
      resizeCbs.push(cb);
      cb(root.clientWidth, root.clientHeight);
    },
    toNdc(e) {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      return ndc;
    },
    dispose() {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      controls.dispose();
      disposeObject(scene);
      scene.environment?.dispose();
      renderer.dispose();
      // WebGL 컨텍스트는 브라우저당 16개 안팎으로 제한된다. 실험을 오갈 때 반드시 반납한다.
      renderer.forceContextLoss();
      root.innerHTML = '';
    },
  };
}
