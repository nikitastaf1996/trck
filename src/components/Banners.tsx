/**
 * Banners — conditional callout banners shown above / below the main
 * stats. Extracted from App.tsx.
 *
 * O7 / O24 refactor: three small presentational components that were
 * previously inlined in App.tsx as conditional JSX blocks. Extracted
 * for clarity and so the conditional rendering rules live next to the
 * visual definition.
 *
 *   - SignalLostBanner: red "ПОТЕРЯ СИГНАЛА GPS" banner. Shown when
 *     recording AND signalLost AND NOT auto-paused (U9).
 *   - BatteryOptBanner: amber Doze-mode warning. Pressable — tapping
 *     re-opens the system battery-optimization dialog.
 *   - OverFilterWarning: amber "all three filters on" warning.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { COLOR } from '../styles';

// ------------------------------------------------------------------
// SignalLostBanner
// ------------------------------------------------------------------

export function SignalLostBanner(): React.ReactElement {
  return (
    <View style={styles.signalLostBanner}>
      <Text style={styles.signalLostTitle}>ПОТЕРЯ СИГНАЛА GPS</Text>
      <Text style={styles.signalLostText}>
        Нет фиксации более 15 с. Запись продолжится; новый сегмент
        трека начнётся автоматически при восстановлении сигнала.
      </Text>
    </View>
  );
}

// ------------------------------------------------------------------
// BatteryOptBanner
// ------------------------------------------------------------------

export interface BatteryOptBannerProps {
  onPress: () => void;
}

export function BatteryOptBanner({ onPress }: BatteryOptBannerProps): React.ReactElement {
  return (
    <Pressable style={styles.batteryOptBanner} onPress={onPress}>
      <Text style={styles.batteryOptBannerText}>
        ⚠️ Фоновые записи могут прерываться (Doze). Нажмите здесь, чтобы настроить.
      </Text>
    </Pressable>
  );
}

// ------------------------------------------------------------------
// OverFilterWarning
// ------------------------------------------------------------------

export function OverFilterWarning(): React.ReactElement {
  return (
    <View style={styles.overFilterWarningContainer}>
      <Text style={styles.overFilterWarningTitle}>
        ⚠ Предупреждение
      </Text>
      <Text style={styles.overFilterWarningBody}>
        Включены все три фильтра прореживания (радиальный, временной,
        Дуглас-Пекер). Трек может получиться слишком редким, особенно
        при медленном движении (ходьба, пеший туризм). Углы и повороты
        могут быть потеряны. Рекомендуется оставить включённым не более
        двух фильтров одновременно.
      </Text>
    </View>
  );
}

// ------------------------------------------------------------------
// PauseBadge — small "АВТОПАУЗА · запись приостановлена" badge shown
// below the TIME BigStat when isAutoPaused is true.
// ------------------------------------------------------------------

export function PauseBadge(): React.ReactElement {
  return (
    <View style={styles.pauseBadge}>
      <View style={styles.pauseDot} />
      <Text style={styles.pauseBadgeText}>
        АВТОПАУЗА · запись приостановлена
      </Text>
    </View>
  );
}

// ------------------------------------------------------------------
// Styles
// ------------------------------------------------------------------

const styles = StyleSheet.create({
  signalLostBanner: {
    backgroundColor: COLOR.signalLostBg,
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLOR.signalLostBorder,
  },
  signalLostTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: COLOR.signalLostAccent,
    letterSpacing: 1.5,
    marginBottom: 6,
  },
  signalLostText: {
    fontSize: 12,
    color: COLOR.signalLostAccent,
    lineHeight: 17,
  },
  batteryOptBanner: {
    backgroundColor: COLOR.pauseBg,
    borderWidth: 1,
    borderColor: COLOR.pauseBorder,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 12,
    marginTop: 4,
  },
  batteryOptBannerText: {
    color: COLOR.pauseAccent,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 16,
    textAlign: 'center',
  },
  overFilterWarningContainer: {
    marginTop: 12,
    marginBottom: 12,
    padding: 12,
    borderRadius: 8,
    backgroundColor: COLOR.pauseBg,
    borderLeftWidth: 4,
    borderLeftColor: COLOR.pauseAccent,
    borderWidth: 1,
    borderColor: COLOR.pauseBorder,
  },
  overFilterWarningTitle: {
    color: COLOR.pauseAccent,
    fontWeight: '700',
    fontSize: 14,
    marginBottom: 4,
  },
  overFilterWarningBody: {
    color: COLOR.pauseAccent,
    fontSize: 13,
    lineHeight: 18,
  },
  pauseBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: -8,
    marginBottom: 4,
  },
  pauseDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: COLOR.pauseAccent,
  },
  pauseBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLOR.pauseAccent,
    letterSpacing: 1.5,
  },
});
