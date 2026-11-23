import { rampCss, type Ramp } from './colormap';

/**
 * 실험 조작 패널. 외부 GUI 라이브러리 없이 필요한 조작 요소만 만든다.
 * 실험마다 화면 오른쪽에 하나씩 붙는다.
 */
export class Panel {
  readonly el: HTMLElement;

  constructor(parent: HTMLElement, title: string, desc?: string) {
    this.el = document.createElement('aside');
    this.el.className = 'panel';
    this.el.innerHTML = `<h2>${title}</h2>${desc ? `<p class="desc">${desc}</p>` : ''}`;
    parent.appendChild(this.el);
  }

  section(title: string): this {
    const h = document.createElement('h3');
    h.textContent = title;
    this.el.appendChild(h);
    return this;
  }

  slider(
    label: string,
    o: { min: number; max: number; step: number; value: number; format?: (v: number) => string },
    onChange: (v: number) => void,
  ): HTMLInputElement {
    const row = this.row(label);
    const input = document.createElement('input');
    input.type = 'range';
    Object.assign(input, { min: o.min, max: o.max, step: o.step, value: o.value });
    const out = document.createElement('output');
    const fmt = o.format ?? ((v: number) => String(v));
    out.textContent = fmt(o.value);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = fmt(v);
      onChange(v);
    });
    row.append(input, out);
    // 외부에서 값을 바꿨을 때 표시를 맞춘다.
    input.addEventListener('sync', () => (out.textContent = fmt(Number(input.value))));
    return input;
  }

  select<T extends string>(label: string, options: Record<T, string>, value: T, onChange: (v: T) => void): HTMLSelectElement {
    const row = this.row(label);
    const sel = document.createElement('select');
    for (const [k, v] of Object.entries(options)) sel.add(new Option(v as string, k, false, k === value));
    sel.addEventListener('change', () => onChange(sel.value as T));
    row.appendChild(sel);
    return sel;
  }

  /** 버튼 묶음 중 하나를 고르는 토글. */
  segmented<T extends string>(label: string, options: Record<T, string>, value: T, onChange: (v: T) => void): void {
    const row = this.row(label);
    const wrap = document.createElement('div');
    wrap.className = 'seg';
    for (const [k, v] of Object.entries(options)) {
      const b = document.createElement('button');
      b.textContent = v as string;
      b.classList.toggle('on', k === value);
      b.addEventListener('click', () => {
        wrap.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        onChange(k as T);
      });
      wrap.appendChild(b);
    }
    row.appendChild(wrap);
  }

  toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLInputElement {
    const row = this.row(label);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value;
    input.addEventListener('change', () => onChange(input.checked));
    row.appendChild(input);
    return input;
  }

  button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = primary ? 'btn primary' : 'btn';
    b.textContent = label;
    b.addEventListener('click', onClick);
    this.el.appendChild(b);
    return b;
  }

  /** 자유 HTML 영역(지표·설명). 반환된 요소의 innerHTML을 갱신한다. */
  info(className = 'info'): HTMLElement {
    const d = document.createElement('div');
    d.className = className;
    this.el.appendChild(d);
    return d;
  }

  legend(ramp: Ramp, min: string, max: string): HTMLElement {
    const d = document.createElement('div');
    d.className = 'legend';
    d.innerHTML = `<div class="bar" style="background:${rampCss(ramp)}"></div><div class="ends"><span>${min}</span><span>${max}</span></div>`;
    this.el.appendChild(d);
    return d;
  }

  private row(label: string): HTMLElement {
    const row = document.createElement('label');
    row.className = 'row';
    const span = document.createElement('span');
    span.textContent = label;
    row.appendChild(span);
    this.el.appendChild(row);
    return row;
  }
}

/** 화면 위 떠 있는 툴팁 하나. */
export function createTooltip(parent: HTMLElement) {
  const el = document.createElement('div');
  el.className = 'tooltip';
  parent.appendChild(el);
  return {
    show(html: string, x: number, y: number) {
      el.innerHTML = html;
      el.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
      el.style.display = 'block';
    },
    hide() {
      el.style.display = 'none';
    },
  };
}
