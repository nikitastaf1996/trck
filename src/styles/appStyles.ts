/**
 * appStyles — StyleSheet entries used by App.tsx, extracted as part of the
 * O7/O24 refactor.
 *
 * Most of the original 39-entry StyleSheet was moved to the extracted
 * components (ToggleRow, StatsDisplay, StartStopButton, SavedCard,
 * ErrorCard, Overlays, Banners) in round 1. What remains here are the
 * layout / container / fallback styles that only App.tsx itself uses.
 */

import { StyleSheet } from 'react-native';
import { COLOR } from './index';

export const appStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLOR.bg },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 60,
  },
  // ---- Settings section header + locked badge ----
  settingsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    marginTop: 4,
    flexWrap: 'wrap',
    gap: 8,
  },
  settingsHeaderText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLOR.secondary,
    letterSpacing: 2,
  },
  settingsLockedBadge: {
    fontSize: 10,
    fontWeight: '600',
    color: COLOR.accentStop,
    backgroundColor: '#FEF2F2',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
  },
  // ---- Permission button ----
  permissionButton: {
    backgroundColor: '#F3F4F6',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLOR.divider,
  },
  permissionButtonText: { color: COLOR.primary, fontSize: 14, fontWeight: '600' },
  // ---- Footer ----
  footerNote: { marginTop: 8 },
  footerText: {
    color: '#9CA3AF',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  // ---- O14: full-screen "native module not loaded" fallback. ----
  nativeMissingContainer: {
    flex: 1,
    backgroundColor: COLOR.bg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  nativeMissingTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: COLOR.errorText,
    marginBottom: 16,
    textAlign: 'center',
  },
  nativeMissingBody: {
    fontSize: 14,
    color: COLOR.secondary,
    textAlign: 'center',
    lineHeight: 20,
  },
});
