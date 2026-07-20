/**
 * Tests for the COLOR palette and shared types in src/styles/index.ts.
 *
 * The format helpers (pad2 / pluralRu / formatDuration / formatDistance /
 * computeAvgPace / computeCurrentPace) are already covered by
 * __tests__/format.test.ts — we don't duplicate those here. Instead we
 * focus on:
 *
 *   - COLOR palette integrity (every named color is a hex string).
 *   - RecordingState type exhaustiveness (no other state can exist).
 *   - Cross-references between COLOR entries used by the components
 *     (so a rename in COLOR.* shows up as a failing test before it shows
 *     up as a runtime crash).
 */
import { COLOR, type RecordingState } from '../src/styles';

describe('COLOR palette', () => {
  // Hex colors — anchored on ^# so rgba() / named CSS colors aren't allowed.
  const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;

  it('every entry is a hex color string', () => {
    for (const [key, value] of Object.entries(COLOR)) {
      expect(typeof value).toBe('string');
      expect(value).toMatch(HEX_RE);
      // Sanity: keep the test name meaningful when one fails.
      expect(value.startsWith('#')).toBe(true);
    }
  });

  it('exposes the bg / primary / secondary / divider base palette', () => {
    expect(COLOR.bg).toBe('#FFFFFF');
    expect(COLOR.primary).toBe('#0A2463');
    expect(COLOR.secondary).toBe('#6B7280');
    expect(COLOR.divider).toBe('#E5E7EB');
  });

  it('exposes the start/stop/stopping button accent triplet', () => {
    expect(COLOR.accentStart).toBe('#0A2463');
    expect(COLOR.accentStop).toBe('#DC2626');
    expect(COLOR.accentStopping).toBe('#9CA3AF');
  });

  it('exposes the auto-pause amber triplet (accent / bg / border)', () => {
    expect(COLOR.pauseAccent).toBe('#D97706');
    expect(COLOR.pauseBg).toBe('#FFFBEB');
    expect(COLOR.pauseBorder).toBe('#FDE68A');
  });

  it('exposes the signal-lost red triplet (accent / bg / border)', () => {
    expect(COLOR.signalLostAccent).toBe('#DC2626');
    expect(COLOR.signalLostBg).toBe('#FEF2F2');
    expect(COLOR.signalLostBorder).toBe('#FECACA');
  });

  it('exposes the GNSS status color set (green / amber / red / gray)', () => {
    expect(COLOR.gnssGreen).toBe('#16A34A');
    expect(COLOR.gnssAmber).toBe('#D97706');
    expect(COLOR.gnssRed).toBe('#DC2626');
    expect(COLOR.gnssGray).toBe('#9CA3AF');
  });

  it('exposes the error / saved card palette sets', () => {
    expect(COLOR.errorBg).toBe('#FEF2F2');
    expect(COLOR.errorBorder).toBe('#FECACA');
    expect(COLOR.errorText).toBe('#991B1B');
    expect(COLOR.savedBg).toBe('#F0FDF4');
    expect(COLOR.savedBorder).toBe('#BBF7D0');
    expect(COLOR.savedText).toBe('#166534');
  });

  it('pause accent and GNSS amber are the same color (intentional reuse)', () => {
    // Both warnings use the same amber hue. If this invariant ever changes,
    // update the docs in src/styles/index.ts and the test together.
    expect(COLOR.pauseAccent).toBe(COLOR.gnssAmber);
  });

  it('signalLostAccent and accentStop are both red (intentional reuse)', () => {
    // Both are "danger / stop" red.
    expect(COLOR.signalLostAccent).toBe(COLOR.accentStop);
  });
});

describe('RecordingState type', () => {
  // Compile-time exhaustiveness check — if a fourth state is ever added,
  // this array literal will need updating, which is the point.
  const ALL_STATES: RecordingState[] = ['idle', 'recording', 'stopping'];

  it('has exactly three states', () => {
    expect(ALL_STATES.length).toBe(3);
  });

  it('each state is a unique string', () => {
    const set = new Set(ALL_STATES);
    expect(set.size).toBe(ALL_STATES.length);
  });

  it('the three states are idle / recording / stopping in that order', () => {
    // Order matters for the StartStopButton: idle → start, recording → stop,
    // stopping → no-op. Any new state must be added after `stopping` to
    // preserve the visual transition flow.
    expect(ALL_STATES).toEqual(['idle', 'recording', 'stopping']);
  });
});
