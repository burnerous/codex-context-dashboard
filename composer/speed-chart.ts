import type { SpeedSample } from "./speed.ts";

export function drawSpeedChart(canvas: HTMLCanvasElement, samples: readonly SpeedSample[]) {
  const box = canvas.getBoundingClientRect();
  if (!box.width || !box.height || !samples.length) return;
  const scale = Math.min(devicePixelRatio || 1, 3);
  const width = Math.round(box.width * scale);
  const height = Math.round(box.height * scale);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(scale, 0, 0, scale, 0, 0);
  g.clearRect(0, 0, box.width, box.height);
  const style = getComputedStyle(canvas);
  const left = 4;
  const right = box.width - 4;
  const bottom = box.height - 5;
  const ceiling = Math.max(...samples.map(({ rate }) => rate), 1) * 1.12;
  const step = (right - left) / Math.max(1, samples.length - 1);
  const points = samples.map(({ rate }, index) => ({
    x: samples.length === 1 ? right : left + index * step,
    y: bottom - rate / ceiling * (bottom - 4),
  }));

  g.strokeStyle = style.getPropertyValue("--cup-border");
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(left, bottom + 0.5);
  g.lineTo(right, bottom + 0.5);
  g.stroke();

  g.strokeStyle = g.fillStyle = style.getPropertyValue("--cup-accent");
  g.lineWidth = 1.75;
  g.lineJoin = "round";
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(points[0].x, points[0].y);
  for (const { x, y } of points.slice(1)) g.lineTo(x, y);
  g.stroke();

  const last = points[points.length - 1];
  g.beginPath();
  g.arc(last.x, last.y, 2.7, 0, 2 * Math.PI);
  g.fill();
}
