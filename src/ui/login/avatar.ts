// Initials avatar helpers (pure).

/** Up to two upper-case initials of a user name. */
export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] as string;
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  return (first.charAt(0) + (parts[parts.length - 1] as string).charAt(0)).toUpperCase();
}

/** Stable hue (0-359) derived from a name. */
export function hueFor(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

/** The server address as it will be contacted (mirrors the client's normalisation). */
export function previewServer(input: string): string {
  const url = input.trim();
  if (url === '') return '';
  return url.includes('://') ? url : `http://${url}`;
}
