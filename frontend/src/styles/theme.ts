/**
 * Design tokens for JavaScript/Canvas contexts that can't use CSS variables.
 * Keep in sync with tokens.css — this is the JS mirror of the same values.
 */
export const theme = {
  accent: '#D81B60',
  accentHover: '#E91E63',
  accentTint: 'rgba(216, 27, 96, 0.15)',
  accentFill: 'rgba(216, 27, 96, 0.25)',
  accept: '#26C6A0',
  acceptFill: 'rgba(38, 198, 160, 0.2)',
  reject: '#EF4565',
  rejectFill: 'rgba(239, 69, 101, 0.2)',
  pending: '#FFAB40',
  pendingFill: 'rgba(255, 171, 64, 0.2)',
  text: '#EAEAF0',
  textMuted: '#A9A9B6',
  textDisabled: '#6E6E7A',
  white: '#ffffff',
  surface: '#15151C',
  bg: '#0F0F14',
  border: 'rgba(255, 255, 255, 0.08)',
  fontFamily: 'Inter, system-ui, -apple-system, sans-serif',

  // Canvas overlay colors (test frame / scan preview)
  testFrame: '#00dcff',
  testFrameFill: 'rgba(0, 220, 255, 0.18)',
  scanPreview: '#ffc800',
  scanPreviewFill: 'rgba(255, 200, 0, 0.22)',
} as const

/**
 * PII type label colors — used in FrameTestModal and SettingsModal badges.
 * Single source of truth for PII type → color mapping.
 */
export const PII_LABEL_COLORS: Record<string, string> = {
  phone: '#B39DDB',
  email: '#80CBC4',
  person: '#F48FB1',
  address: '#FFD54F',
  credit_card: '#FFAB91',
  ssn: '#EF9A9A',
  account_id: '#80DEEA',
  employee_id: '#A5D6A7',
  postal_code: '#CE93D8',
  username: '#DCE775',
  custom: '#90A4AE',
  unknown: '#78909C',
}
