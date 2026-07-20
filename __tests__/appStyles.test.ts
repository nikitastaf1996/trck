/**
 * Tests for appStyles — the StyleSheet entries that App.tsx owns directly.
 *
 * StyleSheet.create is a no-op in the Jest environment (RN's jest mock
 * returns the input object verbatim), so we can assert on the raw shape
 * of the styles object. This catches regressions where:
 *
 *   - A style key is silently renamed (e.g. `footerText` → `footerLabel`)
 *     and breaks a `style={styles.footerText}` reference in App.tsx.
 *   - A style key is deleted without removing its usage in App.tsx.
 *   - A style value loses a critical property (e.g. `color` removed from
 *     `permissionButtonText`).
 */
import { appStyles } from '../src/styles/appStyles';
import { COLOR } from '../src/styles';

describe('appStyles', () => {
  it('exports a non-empty object', () => {
    expect(typeof appStyles).toBe('object');
    expect(Object.keys(appStyles).length).toBeGreaterThan(0);
  });

  it('has the container style with bg color and flex 1', () => {
    expect(appStyles.container).toEqual(
      expect.objectContaining({ flex: 1, backgroundColor: COLOR.bg })
    );
  });

  it('has the scrollContent style with the App.tsx horizontal / vertical paddings', () => {
    // Catch regressions where someone removes the bottom padding (which
    // would clip the last setting row on small screens).
    expect(appStyles.scrollContent).toEqual(
      expect.objectContaining({
        paddingHorizontal: 24,
        paddingTop: 16,
        paddingBottom: 60,
      })
    );
  });

  it('settingsHeader uses row layout with space-between justification', () => {
    expect(appStyles.settingsHeader).toEqual(
      expect.objectContaining({
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
      })
    );
  });

  it('settingsLockedBadge uses the danger-red accent color', () => {
    expect(appStyles.settingsLockedBadge).toEqual(
      expect.objectContaining({
        color: COLOR.accentStop,
        backgroundColor: '#FEF2F2',
      })
    );
  });

  it('permissionButton uses the divider border color and 12px corner radius', () => {
    expect(appStyles.permissionButton).toEqual(
      expect.objectContaining({
        backgroundColor: '#F3F4F6',
        borderRadius: 12,
        borderColor: COLOR.divider,
        borderWidth: 1,
      })
    );
  });

  it('permissionButtonText uses the primary navy color', () => {
    expect(appStyles.permissionButtonText).toEqual(
      expect.objectContaining({ color: COLOR.primary, fontWeight: '600' })
    );
  });

  it('footerText is centered with the muted gray color', () => {
    expect(appStyles.footerText).toEqual(
      expect.objectContaining({
        color: '#9CA3AF',
        textAlign: 'center',
      })
    );
  });

  it('nativeMissingContainer is full-screen centered (flex 1 + alignItems center)', () => {
    expect(appStyles.nativeMissingContainer).toEqual(
      expect.objectContaining({
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: COLOR.bg,
      })
    );
  });

  it('nativeMissingTitle uses the error text color', () => {
    expect(appStyles.nativeMissingTitle).toEqual(
      expect.objectContaining({ color: COLOR.errorText, fontWeight: '700' })
    );
  });

  it('nativeMissingBody uses the muted secondary color', () => {
    expect(appStyles.nativeMissingBody).toEqual(
      expect.objectContaining({ color: COLOR.secondary })
    );
  });
});
