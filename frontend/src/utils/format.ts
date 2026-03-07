/**
 * Format a millisecond timestamp as a human-readable time string.
 *
 * @param ms - Time in milliseconds.
 * @returns Formatted string: "M:SS" for under an hour, "H:MM:SS" for longer.
 */
export function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
