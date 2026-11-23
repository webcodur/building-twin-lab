import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createStage } from '../core/stage';
import { Panel } from '../core/panel';
import { disposeObject } from '../core/dispose';
import { layout, type Lab } from './types';

/**
 * 도면 → 3D 매스·외피 자동 생성.
 * 실(방)을 사각형으로 그리면 격자로 래스터화해 외벽·내벽을 판정하고, 외벽에만 창을 낸다.
 * 결과는 방위별 외피·창 면적 JSON으로 내보내 에너지 시뮬레이션 입력으로 쓴다.
 */

const S = 0.5; // 격자 m
const W = 80; // 격자 수 (40 m)
const D = 60; // (30 m)
const OX = -(W * S) / 2;
const OZ = -(D * S) / 2;
const FH = 3.4;
const SILL = 0.9;
const HEAD = 2.4;

type RoomType = 'office' | 'meeting' | 'corridor' | 'service';
const ROOM: Record<RoomType, { name: string; color: number }> = {
  office: { name: '사무', color: 0x3b82f6 },
  meeting: { name: '회의', color: 0xa855f7 },
  corridor: { name: '복도', color: 0x64748b },
  service: { name: '설비·화장실', color: 0xf59e0b },
};

interface Room {
  x0: number;
  z0: number;
  x1: number;
  z1: number; // 격자 좌표, x1·z1 미포함
  type: RoomType;
}

type Dir = 'N' | 'S' | 'E' | 'W';
interface Envelope {
  wall: Record<Dir, number>;
  window: Record<Dir, number>;
  interiorWall: number;
}

interface Edge {
  ext: boolean;
  dir: Dir | null; // 외벽의 바깥 방향
  axis: 'x' | 'z'; // 벽이 뻗는 방향
  line: number; // 격자선 위치
  a: number;
  b: number;
}

const PRESET: Room[] = [
  { x0: 10, z0: 16, x1: 34, z1: 28, type: 'office' },
  { x0: 34, z0: 16, x1: 46, z1: 28, type: 'meeting' },
  { x0: 46, z0: 16, x1: 70, z1: 28, type: 'office' },
  { x0: 10, z0: 28, x1: 70, z1: 33, type: 'corridor' },
  { x0: 10, z0: 33, x1: 26, z1: 44, type: 'meeting' },
  { x0: 26, z0: 33, x1: 38, z1: 44, type: 'service' },
  { x0: 38, z0: 33, x1: 70, z1: 44, type: 'office' },
];

export const planLab: Lab = {
  id: 'plan',
  title: '도면 → 3D 매스·외피',
  tag: '건물 DX 자동화',
  summary: '도면 이미지를 깔고 실을 그리면 외벽·내벽·창호가 즉시 생긴다. 방위별 외피 면적을 에너지 시뮬레이션 입력 JSON으로 내보낸다.',
  mount(el) {
    const { viewport, side } = layout(el);
    viewport.classList.add('dropzone');
    const stage = createStage(viewport, { background: 0x0b1020, shadows: true });
    const { scene, camera, controls } = stage;
    scene.add(new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(-25, 40, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30 });
    scene.add(sun);

    const groundGeo = new THREE.PlaneGeometry(W * S, D * S);
    groundGeo.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 1 }));
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(W * S, W, 0x334155, 0x1a2338);
    grid.scale.z = D / W;
    grid.position.y = 0.02;
    scene.add(grid);

    // 도면 밑그림
    const underlay = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false }));
    underlay.position.y = 0.03;
    underlay.visible = false;
    scene.add(underlay);
    let underlayAspect = 1;

    const north = document.createElement('div');
    north.className = 'floor-tag';
    north.textContent = '▲ 북';
    const northObj = new CSS2DObject(north);
    northObj.position.set(0, 0, OZ - 1.5);
    scene.add(northObj);

    const model = new THREE.Group();
    scene.add(model);
    const roomGroup = new THREE.Group();
    scene.add(roomGroup);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe5e7eb, roughness: 0.85 });
    const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x7dd3fc, metalness: 0.1, roughness: 0.05, transmission: 0.6, transparent: true, opacity: 0.55 });
    const slabMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.9 });

    const state = {
      rooms: PRESET.map((r) => ({ ...r })),
      mode: 'draw' as 'draw' | '3d',
      type: 'office' as RoomType,
      floors: 4,
      wwr: 0.4,
      selected: -1,
    };

    // ── 래스터화 → 벽 판정 ─────────────────────────────────────────
    function edges(): Edge[] {
      const cell = new Int16Array(W * D);
      state.rooms.forEach((r, i) => {
        for (let z = r.z0; z < r.z1; z++) for (let x = r.x0; x < r.x1; x++) cell[x + z * W] = i + 1;
      });
      const at = (x: number, z: number) => (x < 0 || z < 0 || x >= W || z >= D ? 0 : cell[x + z * W]);
      const pieces: Edge[] = [];
      // 세로 격자선(x = i+1): 왼쪽 셀과 오른쪽 셀이 다르면 벽
      for (let x = -1; x < W; x++)
        for (let z = 0; z < D; z++) {
          const a = at(x, z), b = at(x + 1, z);
          if (a === b) continue;
          const ext = a === 0 || b === 0;
          pieces.push({ ext, dir: ext ? (a === 0 ? 'W' : 'E') : null, axis: 'z', line: x + 1, a: z, b: z + 1 });
        }
      for (let z = -1; z < D; z++)
        for (let x = 0; x < W; x++) {
          const a = at(x, z), b = at(x, z + 1);
          if (a === b) continue;
          const ext = a === 0 || b === 0;
          // z가 커지는 쪽이 남쪽이다.
          pieces.push({ ext, dir: ext ? (a === 0 ? 'N' : 'S') : null, axis: 'x', line: z + 1, a: x, b: x + 1 });
        }
      // 같은 선 위 연속 조각을 합친다.
      pieces.sort((p, q) => (p.axis < q.axis ? -1 : p.axis > q.axis ? 1 : p.line - q.line || p.a - q.a));
      const out: Edge[] = [];
      for (const p of pieces) {
        const last = out[out.length - 1];
        if (last && last.axis === p.axis && last.line === p.line && last.b === p.a && last.ext === p.ext && last.dir === p.dir) last.b = p.b;
        else out.push({ ...p });
      }
      return out;
    }

    // ── 3D 생성 ───────────────────────────────────────────────────
    let lastEnvelope: Envelope | null = null;
    function rebuild(): Envelope {
      // 재질은 공유하므로 지오메트리만 반납한다.
      model.children.forEach((m) => (m as THREE.Mesh).geometry.dispose());
      model.clear();
      const es = edges();
      const wallGeos: THREE.BufferGeometry[] = [];
      const glassGeos: THREE.BufferGeometry[] = [];
      const slabGeos: THREE.BufferGeometry[] = [];
      const env: Envelope = { wall: { N: 0, S: 0, E: 0, W: 0 }, window: { N: 0, S: 0, E: 0, W: 0 }, interiorWall: 0 };
      const box = (w: number, h: number, d: number, x: number, y: number, z: number, list: THREE.BufferGeometry[]) => {
        if (w <= 0.001 || h <= 0.001 || d <= 0.001) return;
        list.push(new THREE.BoxGeometry(w, h, d).translate(x, y, z));
      };

      for (let f = 0; f < state.floors; f++) {
        const y0 = f * FH;
        for (const e of es) {
          const len = (e.b - e.a) * S;
          const t = e.ext ? 0.3 : 0.12;
          const h = FH - 0.3;
          const along = (e.a * S + e.b * S) / 2;
          const linePos = e.line * S;
          const place = (alongPos: number, w: number, yy: number, hh: number, list: THREE.BufferGeometry[], thick = t) =>
            e.axis === 'x'
              ? box(w, hh, thick, OX + alongPos, y0 + 0.3 + yy + hh / 2, OZ + linePos, list)
              : box(thick, hh, w, OX + linePos, y0 + 0.3 + yy + hh / 2, OZ + alongPos, list);
          if (!e.ext) {
            place(along, len, 0, h, wallGeos);
            env.interiorWall += len * h;
            continue;
          }
          // 외벽: 창 띠를 가운데 두고 아래·위·양옆을 벽으로 채운다.
          const winW = Math.min(len * 0.92, (state.wwr * len * h) / (HEAD - SILL));
          const side = (len - winW) / 2;
          place(along, len, 0, SILL, wallGeos);
          place(along, len, HEAD, h - HEAD, wallGeos);
          place(along - len / 2 + side / 2, side, SILL, HEAD - SILL, wallGeos);
          place(along + len / 2 - side / 2, side, SILL, HEAD - SILL, wallGeos);
          place(along, winW, SILL, HEAD - SILL, glassGeos, 0.06);
          env.wall[e.dir!] += len * h;
          env.window[e.dir!] += winW * (HEAD - SILL);
        }
        for (const r of state.rooms) {
          const w = (r.x1 - r.x0) * S, d = (r.z1 - r.z0) * S;
          box(w, 0.3, d, OX + (r.x0 * S + r.x1 * S) / 2, y0 + 0.15, OZ + (r.z0 * S + r.z1 * S) / 2, slabGeos);
        }
      }
      // 지붕
      for (const r of state.rooms) {
        const w = (r.x1 - r.x0) * S, d = (r.z1 - r.z0) * S;
        box(w, 0.3, d, OX + (r.x0 * S + r.x1 * S) / 2, state.floors * FH + 0.15, OZ + (r.z0 * S + r.z1 * S) / 2, slabGeos);
      }
      // 같은 재질 박스 수백 개를 지오메트리 하나로 합쳐 draw call을 3개로 줄인다.
      const add = (list: THREE.BufferGeometry[], mat: THREE.Material) => {
        if (!list.length) return;
        const m = new THREE.Mesh(mergeGeometries(list), mat);
        m.castShadow = m.receiveShadow = true;
        model.add(m);
        list.forEach((g) => g.dispose());
      };
      add(wallGeos, wallMat);
      add(glassGeos, glassMat);
      add(slabGeos, slabMat);
      model.visible = state.mode === '3d';
      lastEnvelope = env;
      renderRooms();
      renderStats(env);
      return env;
    }

    function renderRooms() {
      roomGroup.children.slice().forEach((c) => {
        c.traverse((o) => o instanceof CSS2DObject && o.element.remove());
      });
      disposeObject(roomGroup);
      roomGroup.clear();
      state.rooms.forEach((r, i) => {
        const w = (r.x1 - r.x0) * S, d = (r.z1 - r.z0) * S;
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: ROOM[r.type].color, transparent: true, opacity: i === state.selected ? 0.75 : 0.4, depthWrite: false }),
        );
        m.position.set(OX + (r.x0 * S + r.x1 * S) / 2, 0.05, OZ + (r.z0 * S + r.z1 * S) / 2);
        m.userData.index = i;
        const tag = document.createElement('div');
        tag.className = 'room-tag';
        tag.innerHTML = `${ROOM[r.type].name}<small>${(w * d).toFixed(0)}㎡</small>`;
        m.add(new CSS2DObject(tag));
        roomGroup.add(m);
      });
      roomGroup.visible = state.mode === 'draw';
    }

    // ── 패널 ──────────────────────────────────────────────────────
    const panel = new Panel(side, '도면 → 3D 매스·외피', '그리기 모드에서 바닥을 끌면 실이 생긴다(0.5m 격자). 실을 누르면 고른다. 도면 이미지를 끌어다 놓으면 밑그림으로 깐다.');
    panel.section('작업');
    panel.segmented('모드', { draw: '그리기', '3d': '3D 보기' }, state.mode, (v) => setMode(v));
    panel.select('새 실 용도', Object.fromEntries(Object.entries(ROOM).map(([k, v]) => [k, v.name])) as Record<RoomType, string>, state.type, (v) => {
      state.type = v;
      if (state.selected >= 0) {
        state.rooms[state.selected].type = v;
        rebuild();
      }
    });
    panel.button('선택한 실 삭제', () => {
      if (state.selected < 0) return;
      state.rooms.splice(state.selected, 1);
      state.selected = -1;
      rebuild();
    });
    panel.button('전부 지우기', () => {
      state.rooms = [];
      state.selected = -1;
      rebuild();
    });
    panel.button('예시 평면 불러오기', () => {
      state.rooms = PRESET.map((r) => ({ ...r }));
      rebuild();
    });
    panel.section('매스·외피');
    panel.slider('층수', { min: 1, max: 12, step: 1, value: state.floors, format: (v) => `${v}층` }, (v) => {
      state.floors = v;
      rebuild();
    });
    panel.slider('창면적비', { min: 0, max: 0.8, step: 0.05, value: state.wwr, format: (v) => `${Math.round(v * 100)}%` }, (v) => {
      state.wwr = v;
      rebuild();
    });
    panel.slider('밑그림 폭', { min: 10, max: 80, step: 1, value: 40, format: (v) => `${v} m` }, (v) => {
      underlay.scale.set(v, 1, v / underlayAspect);
    });
    panel.section('산출');
    const stats = panel.info();
    panel.button('에너지 시뮬레이션 입력 JSON 내려받기', () => download(), true);

    function renderStats(env: Envelope) {
      const floorArea = state.rooms.reduce((a, r) => a + (r.x1 - r.x0) * (r.z1 - r.z0) * S * S, 0);
      const wall = Object.values(env.wall).reduce((a, b) => a + b, 0);
      const win = Object.values(env.window).reduce((a, b) => a + b, 0);
      const vol = floorArea * state.floors * FH;
      const roof = floorArea;
      const dirs: Dir[] = ['N', 'E', 'S', 'W'];
      const label: Record<Dir, string> = { N: '북', E: '동', S: '남', W: '서' };
      stats.innerHTML = `
        <div class="kv"><span>연면적</span><span><em>${(floorArea * state.floors).toFixed(0)} ㎡</em> (${floorArea.toFixed(0)} × ${state.floors})</span></div>
        <div class="kv"><span>체적</span><span>${vol.toFixed(0)} ㎥</span></div>
        <div class="kv"><span>외벽 · 창</span><span>${wall.toFixed(0)} · ${win.toFixed(0)} ㎡</span></div>
        <div class="kv"><span>실제 창면적비</span><span>${wall ? ((win / wall) * 100).toFixed(1) : 0}%</span></div>
        <div class="kv"><span>외피 면적비</span><span>${vol ? ((wall + roof) / vol).toFixed(3) : 0} ㎡/㎥</span></div>
        ${dirs.map((d) => `<div class="kv"><span>${label[d]}측 외벽 · 창</span><span>${env.wall[d].toFixed(0)} · ${env.window[d].toFixed(0)} ㎡</span></div>`).join('')}`;
    }

    function download() {
      if (!lastEnvelope) return;
      const data = {
        schema: 'building-twin-lab/envelope@1',
        gridSize: S,
        floors: state.floors,
        floorHeight: FH,
        rooms: state.rooms.map((r) => ({ type: r.type, x: OX + r.x0 * S, z: OZ + r.z0 * S, w: (r.x1 - r.x0) * S, d: (r.z1 - r.z0) * S })),
        envelope: lastEnvelope,
      };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      a.download = 'envelope.json';
      a.click();
      URL.revokeObjectURL(a.href);
    }

    // ── 모드 전환·카메라 ───────────────────────────────────────────
    const camGoal = new THREE.Vector3();
    function setMode(m: 'draw' | '3d') {
      state.mode = m;
      model.visible = m === '3d';
      roomGroup.visible = m === 'draw';
      grid.visible = m === 'draw';
      northObj.visible = m === 'draw';
      const mb = controls.mouseButtons as Record<string, THREE.MOUSE | null>;
      mb.LEFT = m === 'draw' ? null : THREE.MOUSE.ROTATE;
      controls.enableRotate = m === '3d';
      if (m === 'draw') camGoal.set(0, 42, 0.01);
      else camGoal.set(-30, 30, 38);
      controls.target.set(0, m === 'draw' ? 0 : 4, 0);
    }
    camera.position.set(0, 42, 0.01);
    setMode('draw');
    stage.onFrame((dt) => {
      if (camGoal.lengthSq()) {
        camera.position.lerp(camGoal, Math.min(1, dt * 5));
        if (camera.position.distanceTo(camGoal) < 0.05) camGoal.set(0, 0, 0);
      }
    });
    controls.addEventListener('start', () => camGoal.set(0, 0, 0)); // 사용자가 잡으면 자동 이동을 멈춘다.

    // ── 그리기 ────────────────────────────────────────────────────
    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hitP = new THREE.Vector3();
    const preview = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.35, depthWrite: false }));
    preview.visible = false;
    preview.position.y = 0.07;
    scene.add(preview);
    const toCell = (e: PointerEvent) => {
      ray.setFromCamera(stage.toNdc(e), camera);
      if (!ray.ray.intersectPlane(plane, hitP)) return null;
      return [THREE.MathUtils.clamp(Math.round((hitP.x - OX) / S), 0, W), THREE.MathUtils.clamp(Math.round((hitP.z - OZ) / S), 0, D)] as const;
    };
    let start: readonly [number, number] | null = null;
    let cur: readonly [number, number] | null = null;
    const dom = stage.labels.domElement;
    const rectOf = () => {
      const [ax, az] = start!;
      const [bx, bz] = cur!;
      return { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz) };
    };
    dom.addEventListener('pointerdown', (e) => {
      if (state.mode !== 'draw' || e.button !== 0) return;
      start = cur = toCell(e);
    });
    dom.addEventListener('pointermove', (e) => {
      if (state.mode !== 'draw') return;
      dom.style.cursor = 'crosshair';
      if (!start) return;
      cur = toCell(e) ?? cur;
      const r = rectOf();
      preview.visible = r.x1 > r.x0 && r.z1 > r.z0;
      preview.scale.set((r.x1 - r.x0) * S, 1, (r.z1 - r.z0) * S);
      preview.position.x = OX + ((r.x0 + r.x1) / 2) * S;
      preview.position.z = OZ + ((r.z0 + r.z1) / 2) * S;
    });
    dom.addEventListener('pointerup', (e) => {
      if (state.mode !== 'draw' || !start) return;
      const r = rectOf();
      start = null;
      preview.visible = false;
      if (r.x1 - r.x0 >= 2 && r.z1 - r.z0 >= 2) {
        state.rooms.push({ ...r, type: state.type });
        state.selected = state.rooms.length - 1;
      } else {
        // 클릭: 실 고르기
        ray.setFromCamera(stage.toNdc(e), camera);
        const hit = ray.intersectObjects(roomGroup.children)[0];
        state.selected = hit ? hit.object.userData.index : -1;
      }
      rebuild();
    });
    dom.addEventListener('pointerleave', () => (dom.style.cursor = ''));

    // 도면 이미지 밑그림
    viewport.addEventListener('dragover', (e) => {
      e.preventDefault();
      viewport.classList.add('over');
    });
    viewport.addEventListener('dragleave', () => viewport.classList.remove('over'));
    viewport.addEventListener('drop', (e) => {
      e.preventDefault();
      viewport.classList.remove('over');
      const file = e.dataTransfer?.files[0];
      if (!file?.type.startsWith('image/')) return;
      const url = URL.createObjectURL(file);
      new THREE.TextureLoader().load(url, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        const mat = underlay.material as THREE.MeshBasicMaterial;
        mat.map?.dispose();
        mat.map = tex;
        mat.needsUpdate = true;
        underlayAspect = tex.image.width / tex.image.height;
        underlay.scale.set(40, 1, 40 / underlayAspect);
        underlay.visible = true;
        URL.revokeObjectURL(url);
      });
    });

    rebuild();
    return () => {
      [wallMat, glassMat, slabMat].forEach((m) => m.dispose());
      stage.dispose();
    };
  },
};
