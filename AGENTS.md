# AGENTS.md

스마트 건물관리 PoC용 WebGL·Three.js 연구 실험실이다. 사람용 안내는 `README.md`, 지식은 `docs/`에 있다.

## 로컬 전용 맥락

- `private/CONTEXT.md`가 있으면 작업 전에 먼저 읽는다. 사용자 상황, 대상 기업 정보, 채용 공고, 면접 준비 요약이 들어 있다.
- `private/`는 `.gitignore` 대상이다. 클론한 저장소에는 없다. 없으면 이 절을 건너뛴다.
- 대상 기업 맞춤 판단(실험 우선순위, 용어, 시연 순서)은 이 파일을 근거로 한다.

## 규칙

- 대상 기업명과 사용자 개인 상황은 공개 파일(코드·README·docs·커밋 메시지)에 쓰지 않는다. "대상 기업"으로 부른다. 적을 곳은 `private/CONTEXT.md`뿐이다.
- 화면의 수치는 가상 데이터다. 실측처럼 쓰지 않는다. 시뮬레이션 계수를 바꾸면 `npx tsx scripts/sim-check.mts`로 확인하고 README·`docs/02-poc-ideas.md`의 수치를 함께 고친다.
- 새 실험은 `src/labs/*.ts`의 `Lab` 하나로 만든다. 렌더러 설정·리사이즈·dispose는 `core/stage.ts`에 맡긴다.
- 조작 요소의 hover는 지연 없이 즉시 반응한다.
- 코드를 바꾼 뒤 `pnpm build`와 `pnpm capture`(개발 서버 5180 실행 중)가 오류 0건으로 끝나야 완료다.
- 새로 배운 Three.js·WebGL 사실은 `docs/01-threejs-webgl-notes.md` 해당 절에 바로 적는다. 작업 보고서를 따로 쌓지 않는다.
- 소개 영상은 `media/promo/`(HyperFrames)에서 고친다. 녹화 재료는 `scripts/record.mjs`로 다시 만든다.
