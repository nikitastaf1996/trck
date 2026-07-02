/**
 * ErrorCard — the error display card shown when a native call fails or the
 * foreground service emits an error event. Extracted from App.tsx.
 *
 * O7 / O24 refactor: purely presentational. Includes a "Открыть настройки"
 * button (U2) that opens the system app-settings page — shown only when
 * `hasPermissions === false`, because that's the only recoverable-via-
 * settings error condition we currently surface to the user.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { COLOR } from '../styles';

export interface ErrorCardProps {
  message: string;
  /** When false, a "Открыть настройки" button is shown (U2). */
  hasPermissions: boolean;
  onDismiss: () => void;
  onOpenSettings: () => void;
}

export function ErrorCard({
  message,
  hasPermissions,
  onDismiss,
  onOpenSettings,
}: ErrorCardProps): React.ReactElement {
  return (
    <View style={styles.errorCard}>
      <View style={styles.cardRow}>
        <Text style={styles.errorText}>{message}</Text>
        {/* U19: dismiss button so the user can clear the error card
            without starting a new recording. */}
        <Pressable
          style={styles.cardDismissBtn}
          onPress={onDismiss}
          hitSlop={8}
          accessibilityLabel="Скрыть ошибку"
        >
          <Text style={styles.cardDismissText}>✕</Text>
        </Pressable>
      </View>
      {/* U2: when permissions are missing (permanently denied or just
          not yet granted), offer a button that opens the system app
          settings page so the user can grant them. The native module
          GpsRecorder.openAppSettings() is already exported; the parent
          passes the handler in. The parent's AppState listener
          re-checks hasPermissions when the user returns and updates
          the card automatically. */}
      {!hasPermissions && (
        <Pressable
          style={styles.openSettingsBtn}
          onPress={onOpenSettings}
        >
          <Text style={styles.openSettingsBtnText}>Открыть настройки</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  errorCard: {
    backgroundColor: COLOR.errorBg,
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLOR.errorBorder,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardDismissBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  cardDismissText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLOR.secondary,
    lineHeight: 14,
  },
  errorText: { color: COLOR.errorText, fontSize: 13, flex: 1, paddingRight: 8 },
  openSettingsBtn: {
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: COLOR.errorBorder,
    alignSelf: 'flex-start',
  },
  openSettingsBtnText: {
    color: COLOR.errorText,
    fontSize: 13,
    fontWeight: '600',
  },
});
