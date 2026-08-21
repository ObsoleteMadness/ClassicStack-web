import { describe, expect, it } from 'vitest';
import { clampFrame, menubarMinTop, parseFrame, parseWindowLayouts } from './window-layout';

describe('window layout', () => {
  it('parses stored frames and ignores junk', () => {
    expect(parseWindowLayouts(null)).toEqual({});
    expect(parseWindowLayouts({ finder: { left: 10, top: 20, width: 400, height: 300, maximized: true } })).toEqual({
      finder: { left: 10, top: 20, width: 400, height: 300, maximized: true, open: false, userSized: false },
    });
    expect(parseFrame({ left: 'x', top: 1, width: 2, height: 3 })).toBeNull();
    expect(parseFrame({ left: 1, top: 2, width: 3, height: 4, userSized: true })?.userSized).toBe(true);
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

  it('respects a custom minimum top when clamping', () => {
    const clamped = clampFrame(
      { left: 10, top: 0, width: 400, height: 300, maximized: false },
      { width: 800, height: 600 },
      280,
      160,
      48,
    );
    expect(clamped.top).toBe(48);
    expect(menubarMinTop()).toBeGreaterThan(0);
  });
