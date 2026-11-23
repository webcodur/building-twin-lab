import './style.css';
import type { Lab } from './labs/types';
import { twinLab } from './labs/twin';
import { scanLab } from './labs/scan';
import { planLab } from './labs/plan';
import { envelopeLab } from './labs/envelope';
import { portfolioLab } from './labs/portfolio';
import { ifcLab } from './labs/ifc';

const LABS: Lab[] = [twinLab, ifcLab, scanLab, planLab, envelopeLab, portfolioLab];

const app = document.getElementById('app')!;
const nav = document.getElementById('nav')!;
nav.innerHTML = LABS.map((l, i) => `<a href="#/${l.id}" data-id="${l.id}">${i + 1}. ${l.title}</a>`).join('');

let unmount: (() => void) | null = null;

function home(): void {
  app.innerHTML = `
    <section class="home">
      <h1>스마트 건물관리 3D 실험실</h1>
      <p class="lead">AI 건물 에너지 운영 플랫폼에 붙일 웹 3D 화면을 미리 만들어 보는 실험 모음입니다.
      모든 데이터는 가상 데이터이며, 실험마다 PoC에서 확인할 질문 하나를 다룹니다.</p>
      <div class="cards">
        ${LABS.map(
          (l, i) => `<a class="card" href="#/${l.id}">
            <span class="num">${String(i + 1).padStart(2, '0')}</span>
            <span class="tag">${l.tag}</span>
            <h2>${l.title}</h2>
            <p>${l.summary}</p>
          </a>`,
        ).join('')}
      </div>
    </section>`;
}

function route(): void {
  unmount?.();
  unmount = null;
  const id = location.hash.replace(/^#\/?/, '');
  const lab = LABS.find((l) => l.id === id);
  nav.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.id === id));
  document.body.classList.toggle('is-lab', !!lab);
  if (!lab) return home();
  app.innerHTML = '';
  unmount = lab.mount(app);
}

window.addEventListener('hashchange', route);
route();
