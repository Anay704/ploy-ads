// Brand theming for the workspace: the store's own colors as CSS variables, with a text color
// picked for contrast. Loopy's pink (#F990A8) needs dark text, not white.

import type { CSSProperties } from 'react';

export type BrandColors = { primary: string; secondary: string; accent: string; background: string; text: string };

export const NEUTRAL_COLORS: BrandColors = { primary: '#18181B', secondary: '#E4E4E7', accent: '#18181B', background: '#FFFFFF', text: '#18181B' };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The brand's own text color when it reads on the fill, otherwise white or near-black. */
export function inkOn(fill: string, preferred?: string): string {
  if (preferred && contrast(fill, preferred) >= 4.5) return preferred;
  return contrast(fill, '#FFFFFF') >= contrast(fill, '#18181B') ? '#FFFFFF' : '#18181B';
}

/** CSS variables the workspace reads: --brand, --brand-ink, --brand-2, --brand-text. */
export function brandStyle(colors: BrandColors | null | undefined): CSSProperties {
  const c = colors ?? NEUTRAL_COLORS;
  return {
    '--brand': c.primary,
    '--brand-ink': inkOn(c.primary, c.text),
    '--brand-2': c.secondary,
    '--brand-text': c.text,
  } as CSSProperties;
}
