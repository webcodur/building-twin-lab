import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FlatMesh, IfcAPI } from 'web-ifc';
import wasmUrl from 'web-ifc/web-ifc.wasm?url';
import { createStage } from '../core/stage';
import { Panel, createTooltip } from '../core/panel';
import { RAMPS, sampleRamp } from '../core/colormap';
import { createBuilding } from '../data/building';
import { writeSampleIfc } from '../data/ifc-writer';
import { simulate, STEPS, fmtTime } from '../sim/thermal';
import { layout, type Lab } from './types';

/**
 * IFC(BIM 표준 파일) → Three.js.
 * web-ifc(WASM)로 파일을 읽어 부재별 메시를 만들고, 공간 구조·속성을 보여 준다.
 * 핵심 장면: IFC 공간(IfcSpace)을 BMS 존에 연결해 시간대별 온도로 칠한다.
 */

type Cat = 'space' | 'wall' | 'slab' | 'opening' | 'other';
type ColorMode = 'ifc' | 'temp' | 'category';

const CAT_OF: Record<string, Cat> = {
  IFCSPACE: 'space',
  IFCWALL: 'wall',
  IFCWALLSTANDARDCASE: 'wall',
  IFCCURTAINWALL: 'wall',
  IFCSLAB: 'slab',
  IFCROOF: 'slab',
  IFCCOVERING: 'slab',
  IFCWINDOW: 'opening',
  IFCDOOR: 'opening',
};
const CAT_NAME: Record<Cat, string> = { space: '공간', wall: '벽', slab: '슬래브·지붕', opening: '창·문', other: '기타' };
const CAT_COLOR: Record<Cat, number> = { space: 0xa78bfa, wall: 0xf59e0b, slab: 0x64748b, opening: 0x22d3ee, other: 0xf472b6 };
const TEMP_RANGE = [24.5, 27] as const;

interface Item {
  id: number; // expressID
  type: string; // IFC 클래스 이름
  cat: Cat;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  baseColor: THREE.Color;
  baseOpacity: number;
  storey: number; // 층 순번(-1: 모름)
  name: string;
  zoneIndex: number; // 공간일 때 연결된 존 번호(-1: 없음)
}

interface Storey {
  id: number;
  name: string;
  elevation: number;
  group: THREE.Group;
}

export const ifcLab: Lab = {
  id: 'ifc',
  title: 'IFC(BIM) 모델 → 존 데이터 연결',
  tag: 'BIM·표준',
  summary: '건물 표준 파일(IFC)을 브라우저에서 열어 층·공간·부재를 탐색하고 속성을 본다. IFC 공간을 BMS 제어 존에 연결해 시간대별 온도로 칠한다.',
  mount(el) {
    const { viewport, side } = layout(el);
    viewport.classList.add('dropzone');
    const stage = createStage(viewport, { background: 0x0b1020 });
    const { scene, camera, controls } = stage;
    scene.add(new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-30, 50, 40);
    scene.add(sun);
    const grid = new THREE.GridHelper(200, 100, 0x22304d, 0x16203a);
    scene.add(grid);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'IFC 엔진을 준비하는 중…';
    viewport.appendChild(hint);

    const root = new THREE.Group();
    scene.add(root);

    const zones = createBuilding();
    const sim = simulate(zones);

    // web-ifc(약 1.7MB WASM 포함)는 이 실험을 열 때만 내려받는다(코드 분할).
    let api!: IfcAPI;
    let IFCSPACE = 0;
    let modelID = -1;
    let items: Item[] = [];
    let storeys: Storey[] = [];
    const byMesh = new Map<THREE.Object3D, Item>();
    let selected: Item | null = null;
    let hovered: Item | null = null;
    let disposed = false;

    const state = {
      colorMode: 'ifc' as ColorMode,
      visible: { space: true, wall: true, slab: true, opening: true, other: true } as Record<Cat, boolean>,
      storey: -1,
      explode: 0,
      step: 14 * 12,
      playing: false,
      fileName: '',
      fileSize: 0,
      ms: 0,
    };

    // ── 읽기 ──────────────────────────────────────────────────────
    async function load(bytes: Uint8Array, name: string) {
      clearModel();
      hint.textContent = `${name} 읽는 중…`;
      const t0 = performance.now();
      // 원점에서 먼 실제 좌표의 모델도 화면 가운데로 옮긴다(부동소수점 떨림 방지).
      modelID = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true });
      if (modelID < 0) {
        hint.textContent = '이 파일은 IFC로 읽지 못했다.';
        return;
      }

      // 공간 구조: 프로젝트 > 대지 > 건물 > 층 > (공간·부재)
      const tree = await api.properties.getSpatialStructure(modelID);
      const storeyOf = new Map<number, number>();
      const found: any[] = [];
      const walk = (node: any) => {
        if (String(node.type).toUpperCase() === 'IFCBUILDINGSTOREY') found.push(node);
        node.children?.forEach(walk);
      };
      walk(tree);
      storeys = found
        .map((node) => {
          const line = api.GetLine(modelID, node.expressID);
          return { node, id: node.expressID as number, name: (line.Name?.value as string) ?? `층 ${node.expressID}`, elevation: Number(line.Elevation?.value ?? 0) };
        })
        .sort((a, b) => a.elevation - b.elevation)
        .map((s, i) => {
          // 층 아래 모든 자손(공간·부재)에 층 순번을 매긴다.
          const mark = (n: any) => {
            storeyOf.set(n.expressID, i);
            n.children?.forEach(mark);
          };
          s.node.children.forEach(mark);
          const group = new THREE.Group();
          root.add(group);
          return { id: s.id, name: s.name, elevation: s.elevation, group };
        });
      const loose = new THREE.Group();
      root.add(loose);

      // 형상: 부재마다 배치된 조각들을 합쳐 메시 하나로 만든다.
      const matCache = new Map<string, THREE.MeshStandardMaterial>();
      const zoneByName = new Map(zones.map((z, i) => [z.id, i]));
      let spaceCount = 0;
      const onMesh = (fm: FlatMesh) => {
        const geos: THREE.BufferGeometry[] = [];
        let color = new THREE.Color(0xcccccc);
        let opacity = 1;
        for (let i = 0; i < fm.geometries.size(); i++) {
          const pg = fm.geometries.get(i);
          const g = api.GetGeometry(modelID, pg.geometryExpressID);
          // WASM 메모리를 가리키는 뷰라서 바로 복사한다. 정점은 [x,y,z,nx,ny,nz] 교차 배열이다.
          const v = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
          const idx = api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize());
          const pos = new Float32Array(v.length / 2);
          const nor = new Float32Array(v.length / 2);
          for (let k = 0, j = 0; k < v.length; k += 6, j += 3) {
            pos[j] = v[k]; pos[j + 1] = v[k + 1]; pos[j + 2] = v[k + 2];
            nor[j] = v[k + 3]; nor[j + 1] = v[k + 4]; nor[j + 2] = v[k + 5];
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
          geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
          geo.applyMatrix4(new THREE.Matrix4().fromArray(pg.flatTransformation));
          geos.push(geo);
          g.delete();
          color = new THREE.Color().setRGB(pg.color.x, pg.color.y, pg.color.z, THREE.SRGBColorSpace);
          opacity = pg.color.w;
        }
        if (!geos.length) return;
        const geometry = geos.length > 1 ? mergeGeometries(geos) : geos[0];
        if (geos.length > 1) geos.forEach((g) => g.dispose());
        const type = api.GetNameFromTypeCode(api.GetLineType(modelID, fm.expressID));
        const cat = CAT_OF[type.toUpperCase()] ?? 'other';
        const line = api.GetLine(modelID, fm.expressID);
        const name = line.Name?.value ?? line.LongName?.value ?? type;
        // 재질은 부재마다 따로 둔다. 선택 강조·온도 색을 부재 단위로 바꾸기 위해서다.
        const key = `${color.getHexString()}-${opacity}`;
        const proto = matCache.get(key) ?? new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.05, side: THREE.DoubleSide });
        matCache.set(key, proto);
        const mat = proto.clone();
        mat.color.copy(color);
        mat.opacity = cat === 'space' ? Math.min(opacity, 0.35) : opacity;
        mat.transparent = mat.opacity < 1;
        mat.depthWrite = !mat.transparent;
        const mesh = new THREE.Mesh(geometry, mat);
        const storey = storeyOf.get(fm.expressID) ?? -1;
        (storey >= 0 ? storeys[storey].group : loose).add(mesh);
        // 존 연결: 공간 이름이 BMS 존 ID와 같으면 그 존, 아니면 순서대로 가상 연결한다.
        const zoneIndex = cat === 'space' ? (zoneByName.get(name) ?? spaceCount++ % zones.length) : -1;
        const item: Item = { id: fm.expressID, type, cat, mesh, baseColor: color.clone(), baseOpacity: mat.opacity, storey, name, zoneIndex };
        items.push(item);
        byMesh.set(mesh, item);
      };
      api.StreamAllMeshes(modelID, onMesh);
      // 공간은 기본 스트림에서 빠지므로 따로 받는다.
      api.StreamAllMeshesWithTypes(modelID, [IFCSPACE], onMesh);
      matCache.forEach((m) => m.dispose());

      state.ms = performance.now() - t0;
      state.fileName = name;
      state.fileSize = bytes.byteLength;
      fitCamera();
      renderTree();
      renderStats();
      floorSelect.length = 0;
      floorSelect.add(new Option('전체', '-1'));
      storeys.forEach((s, i) => floorSelect.add(new Option(s.name, String(i))));
      state.storey = -1;
      const linked = items.some((it) => it.cat === 'space' && zoneByName.has(it.name));
      hint.textContent = `${name} · 클릭하면 속성이 열린다${items.some((i) => i.cat === 'space') ? (linked ? ' · 공간이 BMS 존에 연결됨' : ' · 공간을 가상 존에 연결함') : ''}`;
      applyLook();
    }

    function clearModel() {
      if (modelID >= 0) api.CloseModel(modelID);
      modelID = -1;
      for (const it of items) {
        it.mesh.geometry.dispose();
        it.mesh.material.dispose();
      }
      root.clear();
      items = [];
      storeys = [];
      byMesh.clear();
      selected = hovered = null;
      detail.innerHTML = '<p class="muted">부재를 누르면 IFC 속성이 열린다.</p>';
    }

    function fitCamera() {
      const box = new THREE.Box3().setFromObject(root);
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3()).length();
      const c = box.getCenter(new THREE.Vector3());
      controls.target.copy(c);
      camera.position.copy(c).add(new THREE.Vector3(-0.8, 0.6, 0.9).multiplyScalar(size * 0.85));
      camera.near = size / 1000;
      camera.far = size * 20;
      camera.updateProjectionMatrix();
      grid.position.y = box.min.y - 0.01;
    }

    // ── 보이기·색 ─────────────────────────────────────────────────
    const tmp = new THREE.Color();
    function applyLook() {
      const s = state.step;
      for (const it of items) {
        const m = it.mesh.material;
        const inFloor = state.storey < 0 || it.storey === state.storey;
        it.mesh.visible = state.visible[it.cat] && (state.storey < 0 || it.storey <= state.storey);
        let opacity = it.baseOpacity;
        if (state.colorMode === 'ifc') m.color.copy(it.baseColor);
        else if (state.colorMode === 'category') m.color.setHex(CAT_COLOR[it.cat]);
        else {
          // 온도 모드: 공간만 진하게 칠하고 나머지는 흐리게 둔다.
          if (it.cat === 'space' && it.zoneIndex >= 0) {
            sampleRamp(RAMPS.vivid, (sim.ai.temp[it.zoneIndex][s] - TEMP_RANGE[0]) / (TEMP_RANGE[1] - TEMP_RANGE[0]), tmp);
            m.color.copy(tmp);
            // 반투명 공간이 층층이 겹치면 밝기가 쌓여 하얗게 뜬다. 온도 모드에서는 불투명하게 칠한다.
            opacity = 1;
          } else {
            m.color.copy(it.baseColor);
            opacity = Math.min(it.baseOpacity, it.cat === 'slab' ? 0.12 : 0.05);
          }
        }
        if (!inFloor) opacity = Math.min(opacity, 0.06);
        m.opacity = opacity;
        m.transparent = opacity < 1;
        m.depthWrite = opacity >= 0.8;
        // 온도 모드의 공간은 스스로 빛나게 해 조명·반투명에 색이 묻히지 않게 한다.
        if (it === selected) m.emissive.setHex(0x3b82f6);
        else if (it === hovered) m.emissive.setHex(0x1e3a5f);
        else if (state.colorMode === 'temp' && it.cat === 'space') m.emissive.copy(m.color).multiplyScalar(0.12);
        else m.emissive.setHex(0x000000);
      }
      clockEl.textContent = fmtTime(s);
    }

    // ── 패널 ──────────────────────────────────────────────────────
    const panel = new Panel(
      side,
      'IFC(BIM) 모델 → 존 데이터 연결',
      'IFC는 건물을 "벽·슬래브·창·공간" 같은 객체와 속성으로 담는 국제 표준 파일이다. web-ifc로 읽어 Three.js로 그렸다. .ifc 파일을 끌어다 놓으면 그 모델로 바뀐다.',
    );
    panel.section('모델');
    panel.button('예시 건물 IFC 다시 열기', () => openSample());
    panel.button('예시 건물 IFC 내려받기', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([writeSampleIfc()], { type: 'application/x-step' }));
      a.download = 'sample-building.ifc';
      a.click();
      URL.revokeObjectURL(a.href);
    });
    panel.section('보기');
    panel.segmented('색', { ifc: 'IFC 색', temp: '존 온도', category: '부재 종류' } as Record<ColorMode, string>, state.colorMode, (v) => {
      state.colorMode = v;
      timeRow.style.display = v === 'temp' ? '' : 'none';
      legendBox.innerHTML = '';
      if (v === 'temp') legendBox.appendChild(panel.legend(RAMPS.vivid, `${TEMP_RANGE[0]}℃`, `${TEMP_RANGE[1]}℃`));
      if (v === 'category')
        legendBox.innerHTML = `<div class="chart-legend">${(Object.keys(CAT_NAME) as Cat[]).map((c) => `<span style="color:#${CAT_COLOR[c].toString(16).padStart(6, '0')}">${CAT_NAME[c]}</span>`).join('')}</div>`;
      applyLook();
    });
    const legendBox = panel.info();
    const timeRow = document.createElement('div');
    timeRow.className = 'timerow';
    timeRow.style.display = 'none';
    timeRow.innerHTML = '<button class="play" title="재생/정지">▶</button><span class="clock"></span>';
    panel.el.appendChild(timeRow);
    const clockEl = timeRow.querySelector<HTMLElement>('.clock')!;
    const playBtn = timeRow.querySelector<HTMLButtonElement>('.play')!;
    const timeInput = panel.slider('시각', { min: 0, max: STEPS - 1, step: 1, value: state.step, format: fmtTime }, (v) => {
      state.step = v;
      applyLook();
    });
    timeRow.appendChild(timeInput.parentElement!);
    playBtn.onclick = () => {
      state.playing = !state.playing;
      playBtn.textContent = state.playing ? '❚❚' : '▶';
    };
    const floorSelect = panel.select('층', { '-1': '전체' }, '-1', (v) => {
      state.storey = Number(v);
      applyLook();
    });
    panel.slider('층 분리', { min: 0, max: 1.5, step: 0.01, value: 0, format: (v) => `${Math.round(v * 100)}%` }, (v) => (state.explode = v));
    for (const c of Object.keys(CAT_NAME) as Cat[])
      panel.toggle(CAT_NAME[c], true, (v) => {
        state.visible[c] = v;
        applyLook();
      });
    panel.section('선택한 부재');
    const detail = panel.info('detail');
    panel.section('공간 구조');
    const treeBox = panel.info('tree');
    panel.section('모델 정보');
    const stats = panel.info();

    function renderTree() {
      const spacesOf = (i: number) => items.filter((it) => it.storey === i && it.cat === 'space');
      treeBox.innerHTML = storeys
        .map(
          (s, i) => `<details${i === 0 ? ' open' : ''}><summary data-storey="${i}">${esc(s.name)} <span class="muted">· ${items.filter((it) => it.storey === i).length}개</span></summary>
            ${spacesOf(i).map((it) => `<div class="leaf" data-id="${it.id}">${esc(it.name)}</div>`).join('')}</details>`,
        )
        .join('');
      treeBox.querySelectorAll<HTMLElement>('summary').forEach((el) =>
        el.addEventListener('click', () => {
          state.storey = Number(el.dataset.storey);
          floorSelect.value = String(state.storey);
          applyLook();
        }),
      );
      treeBox.querySelectorAll<HTMLElement>('.leaf').forEach((el) =>
        el.addEventListener('click', () => select(items.find((it) => it.id === Number(el.dataset.id)) ?? null)),
      );
    }

    function renderStats() {
      const count = (c: Cat) => items.filter((i) => i.cat === c).length;
      let tris = 0;
      for (const it of items) tris += (it.mesh.geometry.index?.count ?? 0) / 3;
      stats.innerHTML = `
        <div class="kv"><span>파일</span><span>${esc(state.fileName)} · ${(state.fileSize / 1024).toFixed(0)} KB</span></div>
        <div class="kv"><span>읽기·형상 생성</span><span>${state.ms.toFixed(0)} ms</span></div>
        <div class="kv"><span>층 · 부재</span><span>${storeys.length}개 층 · ${items.length}개</span></div>
        ${(Object.keys(CAT_NAME) as Cat[]).map((c) => `<div class="kv"><span>${CAT_NAME[c]}</span><span>${count(c)}</span></div>`).join('')}
        <div class="kv"><span>삼각형</span><span>${tris.toLocaleString()}</span></div>`;
    }

    async function select(it: Item | null) {
      selected = it;
      applyLook();
      if (!it) {
        detail.innerHTML = '<p class="muted">부재를 누르면 IFC 속성이 열린다.</p>';
        return;
      }
      const line = api.GetLine(modelID, it.id);
      const psets = await api.properties.getPropertySets(modelID, it.id, true);
      const zone = it.zoneIndex >= 0 ? zones[it.zoneIndex] : null;
      detail.innerHTML = `
        <b>${esc(it.name)}</b> <span class="muted">${it.type}</span>
        <div class="kv"><span>GlobalId</span><span class="mono">${esc(line.GlobalId?.value ?? '')}</span></div>
        ${line.LongName?.value ? `<div class="kv"><span>긴 이름</span><span>${esc(line.LongName.value)}</span></div>` : ''}
        <div class="kv"><span>층</span><span>${it.storey >= 0 ? esc(storeys[it.storey].name) : '-'}</span></div>
        ${zone ? `<div class="kv"><span>연결된 존 · ${fmtTime(state.step)}</span><span><em>${zone.id} · ${sim.ai.temp[it.zoneIndex][state.step].toFixed(1)}℃</em></span></div>` : ''}
        ${psets
          .map(
            (p: any) => `<div class="pset"><div class="pset-name">${esc(p.Name?.value ?? '속성 묶음')}</div>${(p.HasProperties ?? [])
              .map((h: any) => `<div class="kv"><span>${esc(h.Name?.value ?? '')}</span><span>${esc(String(h.NominalValue?.value ?? ''))}</span></div>`)
              .join('')}</div>`,
          )
          .join('')}`;
    }

    // ── 상호작용 ──────────────────────────────────────────────────
    const tip = createTooltip(viewport);
    const ray = new THREE.Raycaster();
    const dom = stage.labels.domElement;
    const pick = (e: PointerEvent) => {
      ray.setFromCamera(stage.toNdc(e), camera);
      // 온도 모드에서는 흐리게 둔 벽·슬래브를 지나 공간만 고른다.
      const meshes = items
        .filter((i) => i.mesh.visible && i.mesh.material.opacity > 0.1 && (state.colorMode !== 'temp' || i.cat === 'space'))
        .map((i) => i.mesh);
      const hit = ray.intersectObjects(meshes, false)[0];
      return hit ? (byMesh.get(hit.object) ?? null) : null;
    };
    let downAt = 0;
    dom.addEventListener('pointerdown', () => (downAt = performance.now()));
    dom.addEventListener('pointerup', (e) => {
      if (performance.now() - downAt < 250) select(pick(e));
    });
    dom.addEventListener('pointermove', (e) => {
      const it = pick(e);
      if (it !== hovered) {
        hovered = it;
        applyLook();
      }
      dom.style.cursor = it ? 'pointer' : '';
      if (!it) return tip.hide();
      const r = viewport.getBoundingClientRect();
      const temp = it.zoneIndex >= 0 ? ` · ${sim.ai.temp[it.zoneIndex][state.step].toFixed(1)}℃` : '';
      tip.show(`<b>${esc(it.name)}</b><br>${it.type}${temp}`, e.clientX - r.left, e.clientY - r.top);
    });

    viewport.addEventListener('dragover', (e) => {
      e.preventDefault();
      viewport.classList.add('over');
    });
    viewport.addEventListener('dragleave', () => viewport.classList.remove('over'));
    viewport.addEventListener('drop', async (e) => {
      e.preventDefault();
      viewport.classList.remove('over');
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.ifc')) {
        hint.textContent = '.ifc 파일만 읽는다';
        return;
      }
      await load(new Uint8Array(await file.arrayBuffer()), file.name);
    });

    stage.onFrame((dt) => {
      // 층 분리: 층 그룹을 높이 순서대로 띄운다.
      const gap = 4 * state.explode;
      storeys.forEach((s, i) => (s.group.position.y += (i * gap - s.group.position.y) * Math.min(1, dt * 8)));
      if (state.playing) {
        state.step = (state.step + 1) % STEPS;
        timeInput.value = String(state.step);
        timeInput.dispatchEvent(new Event('sync'));
        applyLook();
      }
    });

    const openSample = () => load(new TextEncoder().encode(writeSampleIfc()), 'sample-building.ifc');

    // WASM은 단일 스레드판을 쓴다. 다중 스레드판은 SharedArrayBuffer(COOP/COEP 헤더)가 필요한데 GitHub Pages는 그 헤더를 못 준다.
    import('web-ifc')
      .then(async (mod) => {
        api = new mod.IfcAPI();
        IFCSPACE = mod.IFCSPACE;
        await api.Init(() => wasmUrl, true);
        if (!disposed) openSample();
      })
      .catch((err) => (hint.textContent = `IFC 엔진을 불러오지 못했다: ${err.message}`));

    return () => {
      disposed = true;
      if (api) clearModel();
      stage.dispose();
    };
  },
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
