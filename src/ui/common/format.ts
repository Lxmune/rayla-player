/** m:ss (or h:mm:ss) for a millisecond position. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "12 tracks" / "1 track". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Stable 0..359 hue for a name (same name, same colour). */
export function nameHue(name: string): number {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/** Deterministic gradient for a name: placeholder art, genre tiles. */
export function nameGradient(name: string): string {
  const hue = nameHue(name);
  return `linear-gradient(135deg, hsl(${hue} 55% 42%), hsl(${(hue + 48) % 360} 60% 24%))`;
}
