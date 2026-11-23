/** 캔버스 2D 선 그래프. 3D 장면 옆에 붙는 작은 시계열에 충분하다. */
export interface Series {
  data: ArrayLike<number>;
  color: string;
  width?: number;
  dash?: number[];
}

export interface ChartOpts {
  min: number;
  max: number;
  cursor?: number; // 인덱스
  band?: [number, number]; // 허용 범위 음영
  gaps?: Array<[number, number]>; // 결측 구간 음영
  yTicks?: number[];
  unit?: string;
}

export function drawChart(canvas: HTMLCanvasElement, series: Series[], o: ChartOpts): void {
  const dpr = Math.min(window.devicePixelRatio, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const n = series[0]?.data.length ?? 0;
  if (!n) return;
  const padL = o.yTicks ? 30 : 4;
  const x = (i: number) => padL + (i / (n - 1)) * (w - padL - 4);
  const y = (v: number) => h - 4 - ((v - o.min) / (o.max - o.min)) * (h - 8);

  if (o.band) {
    g.fillStyle = 'rgba(120, 220, 160, 0.10)';
    g.fillRect(padL, y(o.band[1]), w - padL, y(o.band[0]) - y(o.band[1]));
  }
  for (const [a, b] of o.gaps ?? []) {
    g.fillStyle = 'rgba(255, 90, 90, 0.16)';
    g.fillRect(x(a), 0, x(b) - x(a), h);
  }
  g.font = '10px Pretendard Variable, sans-serif';
  g.fillStyle = 'rgba(200, 210, 230, 0.6)';
  g.strokeStyle = 'rgba(200, 210, 230, 0.08)';
  for (const t of o.yTicks ?? []) {
    g.beginPath();
    g.moveTo(padL, y(t));
    g.lineTo(w, y(t));
    g.stroke();
    g.fillText(`${t}${o.unit ?? ''}`, 2, y(t) + 3);
  }
  for (const s of series) {
    g.beginPath();
    g.strokeStyle = s.color;
    g.lineWidth = s.width ?? 1.5;
    g.setLineDash(s.dash ?? []);
    for (let i = 0; i < n; i++) {
      const px = x(i);
      const py = y(s.data[i]);
      i ? g.lineTo(px, py) : g.moveTo(px, py);
    }
    g.stroke();
  }
  g.setLineDash([]);
  if (o.cursor !== undefined) {
    g.strokeStyle = 'rgba(255,255,255,0.8)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x(o.cursor), 0);
    g.lineTo(x(o.cursor), h);
    g.stroke();
  }
}
