/**
 * Overlays — full-screen modal overlays shown above the main ScrollView.
 * Extracted from App.tsx.
 *
 * O7 / O24 refactor: two variants that share the same layout but differ in
 * spinner color, text, and presence of a cancel button:
 *
 *   1. PermissionWaitOverlay (U1) — shown while the system permission
 *      dialog is on screen. Has a "Отмена" cancel button so the user can
 *      abort the wait. Spinner color: COLOR.primary.
 *
 *   2. StopOverlay (U20) — shown while recordingState === 'stopping' so
 *      the user knows the finalize step (Gaussian smoothing + Douglas-
 *      Peucker on a long track) is in progress. No cancel button (the
 *      stop is irreversible). Spinner color: COLOR.accentStop.
 */

import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { COLOR } from '../styles';

export interface OverlayProps {
  visible: boolean;
  spinnerColor: string;
  text: string;
  onCancel?: () => void;
  cancelLabel?: string;
}

/**
 * A generic overlay component. The parent toggles `visible` to show/hide.
 * When `onCancel` is provided, a cancel button is rendered below the text.
 */
export function Overlay({
  visible,
  spinnerColor,
  text,
  onCancel,
  cancelLabel = 'Отмена',
}: OverlayProps): React.ReactElement | null {
  if (!visible) return null;
  return (
    <View style={styles.permissionWaitOverlay}>
      <View style={styles.permissionWaitCard}>
        <ActivityIndicator size="large" color={spinnerColor} />
        <Text style={styles.permissionWaitText}>{text}</Text>
        {onCancel && (
          <Pressable
            style={styles.permissionWaitCancelBtn}
            onPress={onCancel}
          >
            <Text style={styles.permissionWaitCancelText}>{cancelLabel}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** Convenience wrapper for the permission-wait overlay (U1). */
export function PermissionWaitOverlay(props: Omit<OverlayProps, 'spinnerColor' | 'text'> & {
  text?: string;
}): React.ReactElement | null {
  return (
    <Overlay
      visible={props.visible}
      spinnerColor={COLOR.primary}
      text={props.text ?? 'Ожидание разрешений…'}
      onCancel={props.onCancel}
    />
  );
}

/** Convenience wrapper for the stop/save overlay (U20). */
export function StopOverlay(props: Omit<OverlayProps, 'spinnerColor' | 'text' | 'onCancel' | 'cancelLabel'> & {
  text?: string;
}): React.ReactElement | null {
  return (
    <Overlay
      visible={props.visible}
      spinnerColor={COLOR.accentStop}
      text={props.text ?? 'Сохранение GPX…'}
    />
  );
}

const styles = StyleSheet.create({
  permissionWaitOverlay: {
    position: 'absolute',
    left: 0, right: 0, top: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  permissionWaitCard: {
    backgroundColor: COLOR.bg,
    borderRadius: 16,
    paddingVertical: 24,
    paddingHorizontal: 32,
    alignItems: 'center',
    minWidth: 220,
    elevation: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25, shadowRadius: 16,
  },
  permissionWaitText: {
    marginTop: 14,
    fontSize: 14,
    fontWeight: '600',
    color: COLOR.primary,
    textAlign: 'center',
  },
  permissionWaitCancelBtn: {
    marginTop: 18,
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLOR.divider,
    backgroundColor: '#F3F4F6',
  },
  permissionWaitCancelText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLOR.primary,
  },
});
