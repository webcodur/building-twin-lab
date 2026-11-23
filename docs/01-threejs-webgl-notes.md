# Three.js·WebGL 연구 노트

이 실험실을 만들면서 확인한 사실과 함정을 정리한다. 버전은 three 0.187, Vite 8, TypeScript 7 기준이다. 수치는 RTX 4070, Chrome, 1600×900 뷰포트에서 실측했다.

## 1. 무대 설정 — 모든 장면의 출발점

`src/core/stage.ts` 하나가 렌더러·카메라·컨트롤·라벨·리사이즈·루프·정리를 쥔다. 실험마다 반복하지 않는다.

| 설정 | 값 | 이유 |
|---|---|---|
| `outputColorSpace` | `SRGBColorSpace` | 화면 출력 색공간. 빼면 전체가 어둡고 탁하다 |
| `toneMapping` | `ACESFilmicToneMapping` | 밝은 영역이 하얗게 날아가지 않는다 |
| `setPixelRatio` | `min(devicePixelRatio, 2)` | 4K·레티나에서 픽셀 수가 4배 이상으로 늘어나는 것을 막는다 |
| `scene.environment` | `PMREMGenerator` + `RoomEnvironment` | HDR 파일 없이도 PBR 재질(금속·유리)이 산다 |
| `OrbitControls` | 감쇠 on, `maxPolarAngle < π/2` | 바닥 아래로 카메라가 내려가지 않는다 |
| 루프 | `renderer.setAnimationLoop` + `THREE.Timer` | 0.187에서는 `Clock` 대신 `Timer`를 쓴다. `update(time)` 뒤 `getDelta()` |
| 리사이즈 | `ResizeObserver(컨테이너)` | `window.resize`는 패널 접힘·레이아웃 변화를 못 잡는다 |

`preserveDrawingBuffer: true`는 캡처·영상 녹화 때문에 켰다. 실서비스에서는 끄는 편이 약간 빠르다.

## 2. 색 관리 — 가장 흔한 "색이 이상하다"의 원인

- `new THREE.Color(0xff8800)`, `setHex`는 sRGB 값을 **선형으로 바꿔 저장**한다. 셰이더에 넘길 때는 그대로 쓰면 된다.
- 직접 쓴 `ShaderMaterial` 프래그먼트 끝에는 `#include <tonemapping_fragment>`와 `#include <colorspace_fragment>`를 넣는다. 빼면 그 재질만 다른 장면과 색이 어긋난다.
- PLY·XYZ 파일의 정점 색은 sRGB로 저장된다. 선형으로 바꿔 넣는다. 0.187은 `THREE.SRGBToLinear`를 내보내지 않아 직접 구현했다(`src/labs/scan.ts` 맨 아래).
- `CanvasTexture`, 도면 이미지 텍스처에는 `colorSpace = SRGBColorSpace`를 지정한다.

## 3. 수명주기와 메모리

- 화면을 오갈 때 `geometry.dispose()`·`material.dispose()`·`texture.dispose()`를 부른다. 장면 그래프를 도는 `disposeObject`(`src/core/dispose.ts`)로 한 번에 처리한다.
- **WebGL 컨텍스트는 브라우저당 16개 안팎이다.** 라우트를 바꿀 때 `renderer.dispose()` 다음에 `renderer.forceContextLoss()`를 부르지 않으면, 실험을 몇 번 오간 뒤 오래된 캔버스가 검게 죽는다.
- 재구성할 때 **공유 재질까지 dispose하면** 매번 셰이더를 다시 컴파일한다. 재구성 경로에서는 지오메트리만 반납한다(`plan.ts` `rebuild`).
- `CSS2DObject`는 부모를 지워도 DOM 요소가 남을 수 있다. 지울 때 `element.remove()`를 직접 부른다.

## 4. 상호작용 — 피킹·선택·드래그

- NDC 좌표는 `window`가 아니라 **캔버스 사각형** 기준으로 계산한다(`stage.toNdc`). 오른쪽 패널이 있으면 그렇게 해야 어긋나지 않는다.
- `CSS2DRenderer`의 레이어가 캔버스 위를 덮는다. `OrbitControls`와 포인터 이벤트를 **라벨 레이어 DOM**에 붙인다.
- 클릭과 회전 드래그를 구분한다. `pointerdown`부터 `pointerup`까지 250ms를 넘으면 선택으로 치지 않는다.
- `pointermove`마다 레이캐스트하지 않는다. 마지막 이벤트만 저장했다가 프레임당 한 번 피킹한다(`portfolio.ts`). 10만 인스턴스에서도 커서가 버벅이지 않는다.
- 도면 그리기는 메시가 아니라 `ray.intersectPlane(y=0)`으로 바닥 좌표를 얻고 격자에 스냅한다.
- 그리기 모드에서는 `controls.mouseButtons.LEFT = null`로 왼쪽 드래그를 컨트롤에서 뺏는다.

## 5. 대량 렌더링 — draw call이 성능을 결정한다

| 기법 | 실험 | 실측 |
|---|---|---|
| `InstancedMesh` | 포트폴리오 | 20,000동, draw call 2개, 삼각형 24만, 93 FPS |
| `mergeGeometries` | 도면→3D | 벽·창·슬래브 박스 수백 개를 메시 3개로 합친다 |
| `Points` + 커스텀 셰이더 | 포인트클라우드 | 145,832점 실시간, 벽 추출 약 10ms |
| `InstancedMesh` + 인스턴스 색 | 외피 | 입면 셀 316개를 1 draw call로 칠한다 |

함정:
- 인스턴스 배치 뒤 `mesh.computeBoundingSphere()`를 부른다. 안 부르면 원점 근처 박스 하나 크기로 판정해, 카메라를 돌릴 때 도시 전체가 사라진다(frustum culling).
- `setColorAt` 뒤에는 `instanceColor.needsUpdate = true`를 준다.
- **인스턴스 색은 diffuse에만 곱해지고 emissive에는 곱해지지 않는다.** 조명과 무관한 열화상 색이 필요하면 `MeshBasicMaterial`로 바꿔 끼운다(`envelope.ts`).
- 인스턴스별 데이터(위상·부하)는 `InstancedBufferAttribute`로 넣는다. 그러면 시간 애니메이션을 CPU 갱신 없이 셰이더에서 처리할 수 있다.
- `InstancedMesh` 레이캐스트는 인스턴스 수에 비례한다(O(n)). 10만을 넘기거나 형상이 복잡하면 `three-mesh-bvh`를 붙인다.

## 6. 표준 재질을 살리면서 셰이더 고치기 — `onBeforeCompile`

`MeshStandardMaterial`을 버리고 `ShaderMaterial`을 새로 쓰면 조명·그림자·안개를 전부 다시 만들어야 한다. `onBeforeCompile`로 기존 셰이더 문자열의 `#include <common>`, `#include <begin_vertex>`, `#include <color_fragment>` 지점에 몇 줄만 끼워 넣는다(`portfolio.ts` 실시간 부하 모드). 유니폼 객체를 바깥에 두고 `shader.uniforms`에 참조로 넣으면, 프레임마다 `uniforms.uTime.value`만 바꾸면 된다.

같은 재질을 다른 조건으로 컴파일해야 하면 `customProgramCacheKey`를 지정한다. 지정하지 않으면 프로그램 캐시가 섞인다.

## 7. 점군 셰이더

- `gl_PointSize = size * pixelRatio * (k / -mvPosition.z)`로 원근 감쇠를 준다.
- `gl_PointCoord`로 원 밖을 `discard`해 둥근 점을 만든다.
- 스캔 연출: 스캐너 위치에서의 거리를 0..1로 정규화한 속성(`aReveal`)을 두고, 유니폼 `uReveal`과 비교해 드러낸다. 경계 근처에 색을 더하면 파면이 빛난다. CPU는 유니폼 하나만 바꾼다.
- 높이 자르기(`uClipY`)도 같은 방식이다. 천장을 걷어 내부를 볼 때 쓴다.

## 8. 후처리

- `EffectComposer`를 쓰면 캔버스의 MSAA가 사라진다. `new WebGLRenderTarget(w, h, { samples: 4, type: HalfFloatType })`을 컴포저에 넘겨 되살린다.
- 톤매핑·색공간 변환은 `OutputPass`가 맡는다. 마지막 패스로 둔다.
- `OutlinePass`는 선택 강조에 좋다. 다만 장면을 여러 번 그리므로 모바일에서는 emissive 강조로 대신하는 것을 검토한다.
- 리사이즈 때 `composer.setPixelRatio`와 `setSize`를 함께 부른다.

## 9. 그림자와 태양

- 방향광 그림자 카메라(`left/right/top/bottom`)를 장면 크기에 맞춰 좁힌다. 넓으면 그림자가 뭉개지고, 좁으면 잘린다.
- 태양 위치는 위도·적위·시간각으로 고도와 방위를 구한다(`envelope.ts` `sunDirection`). 표준시·균시차는 무시한 태양시 근사다. 실서비스에서는 NOAA 알고리즘이나 `suncalc`로 바꾼다.
- 그림자 맵은 "보이는 그림자"일 뿐 값이 아니다. 일사량 같은 수치는 셀 중심에서 태양 방향으로 레이캐스트해 차폐 여부를 계산한다. 셀 316개 × 33시각 ≈ 1만 레이로 즉시 끝난다.

## 10. 시뮬레이션과 시각화를 분리한다

디지털 트윈 화면은 하루치(288스텝) 시계열을 **미리 계산**해 배열로 들고 있다. 렌더 루프는 현재 스텝의 값만 읽는다.
- 시간 슬라이더를 앞뒤로 움직여도 결과가 항상 같다(결정적).
- 고정 스케줄과 AI 제어를 같은 시각에 나란히 비교할 수 있다.
- 실제 PoC에서는 `simulate()` 자리에 BMS 시계열·예측 API 응답을 넣으면 된다. 화면 코드는 바뀌지 않는다.

## 11. 3D와 2D UI의 분업

| 표현 | 수단 |
|---|---|
| 공간에 붙은 이름표·경보 | `CSS2DRenderer` (HTML·CSS 애니메이션을 그대로 쓴다) |
| 시계열 그래프 | 캔버스 2D. 차트 라이브러리 없이 75줄(`core/chart.ts`) |
| 조작 패널 | 일반 DOM. hover는 지연 없이 즉시 반응한다 |
| 범례 | CSS `linear-gradient`. 3D 색 램프와 같은 정지점을 쓴다(`core/colormap.ts`) |

## 12. 검증·캡처 자동화

- 헤드리스 Chrome에서 WebGL을 GPU로 돌리려면 Playwright를 `channel: 'chrome'`과 `--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist`로 띄운다.
- `scripts/capture.mjs`는 실험마다 조작을 재현해 캡처하고 콘솔 오류를 모은다. 코드를 바꾼 뒤 이 스크립트가 오류 0건으로 끝나는지 본다.
- `scripts/record.mjs`는 같은 방식으로 동작 영상을 녹화한다. README 소개 영상의 재료다.
- 시뮬레이션 지표는 `npx tsx scripts/sim-check.mts`로 브라우저 없이 확인한다.

## 13. IFC(BIM) 읽기 — web-ifc

`src/labs/ifc.ts`, `src/data/ifc-writer.ts`, `scripts/ifc-check.mts`가 근거다. web-ifc 0.0.80 기준이다.

| 단계 | 방법 | 함정 |
|---|---|---|
| 엔진 준비 | `new IfcAPI()` → `Init(() => wasmUrl, true)` | 다중 스레드 WASM은 `SharedArrayBuffer`, 즉 COOP·COEP 헤더가 필요하다. GitHub Pages는 그 헤더를 줄 수 없어 단일 스레드(`true`)로 강제한다. wasm 경로는 Vite `?url` import로 받는다 |
| 열기 | `OpenModel(bytes, { COORDINATE_TO_ORIGIN: true })` | 실제 모델은 측지 좌표가 커서 float32 떨림이 생긴다. 원점 이동 옵션을 켠다 |
| 형상 | `StreamAllMeshes` → `PlacedGeometry`마다 `GetGeometry` → `GetVertexArray`·`GetIndexArray` | 정점은 `[x,y,z,nx,ny,nz]` 교차 배열이고 WASM 메모리를 가리키는 뷰다. **즉시 복사**하고 `geometry.delete()`를 부른다. `flatTransformation`(4×4)을 적용한다. 결과는 이미 Y-up이다 |
| 공간 | `StreamAllMeshesWithTypes(model, [IFCSPACE], cb)` | **IfcSpace는 기본 스트림에서 빠진다.** 존 시각화의 핵심이므로 따로 받는다 |
| 종류 | `GetNameFromTypeCode(GetLineType(model, id))` | `IfcWall`처럼 대소문자가 섞여 나온다. 비교할 때는 대문자로 맞춘다 |
| 구조 | `properties.getSpatialStructure(model)` | 노드 필드는 `expressID`·`type`·`children`이다. 층(IfcBuildingStorey) 아래 자손에 층 번호를 매겨 층 분리·고립에 쓴다 |
| 속성 | `GetLine(model, id)`, `properties.getPropertySets(model, id, true)` | 값은 `{ value }` 래퍼로 온다(`line.Name.value`) |
| 클릭 | 메시 → `Map<Mesh, expressID>` → 속성 조회 | 3D 모양과 BIM 데이터를 expressID 하나로 잇는다 |

IFC를 직접 쓸 때(`ifc-writer.ts`):
- STEP 실수에는 소수점이 반드시 있어야 한다(`3.`, `0.3`).
- ASCII 밖 문자(한글)는 `\X2\C8FC\X0\`처럼 UTF-16 16진수 블록으로 쓴다. web-ifc가 정상으로 디코딩한다.
- 최소 골격은 `IfcProject > IfcSite > IfcBuilding > IfcBuildingStorey`(IfcRelAggregates)이고, 부재는 `IfcRelContainedInSpatialStructure`, 공간은 층에 IfcRelAggregates로 단다.
- 형상은 `IfcRectangleProfileDef` + `IfcExtrudedAreaSolid`가 가장 짧다. 색은 `IfcStyledItem` → `IfcSurfaceStyle` → `IfcSurfaceStyleRendering`이다.
- 존 연결 정보는 사용자 정의 `Pset_BmsLink`(ZoneId, 온도 포인트)로 공간에 붙였다. 표준 Pset(`Pset_SpaceCommon` 등)과 나란히 둔다.

web-ifc는 JS 3.6MB + WASM 1.7MB다. `import('web-ifc')` 동적 import로 나눠 IFC 화면을 열 때만 내려받게 했다. 첫 화면 번들은 three.js 본체(약 700KB) 그대로다.

큰 모델로 갈 때는 해석을 Worker로 옮기고, 같은 형상(`geometryExpressID`가 같은 것)을 인스턴싱하고, That Open의 fragments 형식으로 변환해 캐시한다.

## 14. 색이 하얗게 뜰 때

IFC 공간을 온도로 칠했더니 전부 파스텔로 떴다. 원인은 셋이 겹친 것이었다.
1. 반투명 공간이 다섯 층 겹치면서 밝기가 누적된다 → 강조 모드에서는 불투명으로 칠한다.
2. 반구광·환경광·발광(emissive)이 겹친 노출 과다를 ACES 톤매핑이 눌러 채도가 빠진다 → 조명을 낮춘다.
3. 값이 몰린 구간이 램프의 옅은 가운데 색이다 → 채도 높은 램프(`RAMPS.vivid`)를 쓰고 범위를 실제 분포에 맞춘다.

## 15. 다음에 시도할 기술

| 기술 | 쓰임 |
|---|---|
| `WebGPURenderer`(`three/webgpu`) + TSL | 컴퓨트 셰이더로 기류 입자·대량 피킹. 같은 셰이더를 WebGL2로 폴백한다 |
| `three-mesh-bvh` | 수십만 인스턴스·대형 BIM에서 레이캐스트 가속 |
| IFC 로더(`web-ifc`, `@thatopen/components`) | 고객이 가진 BIM을 그대로 띄운다 |
| glTF + Draco/Meshopt + KTX2 | 스캔·BIM 결과물을 가볍게 전송한다 |
| 3D Tiles(Cesium, `3d-tiles-renderer`) | 도시·국가 규모 스트리밍 |
| 가우시안 스플래팅 | 스캔한 실내를 사진처럼 재현한다. 점군 단계 다음의 시각화 |
| `OffscreenCanvas` + Worker | 무거운 재구성(벽 추출 등)을 메인 스레드 밖에서 처리한다 |
| WebXR | 현장에서 설비 위치를 AR로 안내한다 |
