export interface Lab {
  id: string;
  title: string;
  tag: string;
  summary: string;
  /** 실험을 붙이고, 정리 함수를 돌려준다. */
  mount(el: HTMLElement): () => void;
}

/** 실험 공통 골격: 왼쪽 3D 뷰포트 + 오른쪽 패널 */
export function layout(el: HTMLElement): { viewport: HTMLElement; side: HTMLElement } {
  el.innerHTML = '<div class="lab"><div class="viewport"></div><div class="side"></div></div>';
  return { viewport: el.querySelector('.viewport')!, side: el.querySelector('.side')! };
}
