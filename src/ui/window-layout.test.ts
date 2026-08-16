import { describe, expect, it } from 'vitest';
import { clampFrame, parseFrame, parseWindowLayouts } from './window-layout';

describe('window layout', () => {
  it('parses stored frames and ignores junk', () => {
    expect(parseWindowLayouts(null)).toEqual({});
    expect(parseWindowLayouts({ finder: { left: 10, top: 20, width: 400, height: 300, maximized: true } })).toEqual({
      finder: { left: 10, top: 20, width: 400, height: 300, maximized: true, open: false },
    });
    expect(parseFrame({ left: 'x', top: 1, width: 2, height: 3 })).toBeNull();
  });

  it('clamps frames onto the viewport', () => {
    const clamped = clampFrame(
      { left: -40, top: 8000, width: 4000, height: 20, maximized: false },
      { width: 800, height: 600 },
      280,
      160,
    );
    expect(clamped.left).toBe(8);
    expect(clamped.top).toBe(560);
    expect(clamped.width).toBe(800);
    expect(clamped.height).toBe(160);
  });
});
