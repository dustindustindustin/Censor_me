import { useEffect } from 'react'
import { useProjectStore } from '../store/projectStore'

const AUTO_DISMISS_MS = 6000

export function ToastContainer() {
  const notifications = useProjectStore((s) => s.notifications)
  const dismissNotification = useProjectStore((s) => s.dismissNotification)

  useEffect(() => {
    if (notifications.length === 0) return
    const oldest = notifications[0]
    const age = Date.now() - oldest.timestamp
    const delay = Math.max(0, AUTO_DISMISS_MS - age)
    const timer = setTimeout(() => dismissNotification(oldest.id), delay)
    return () => clearTimeout(timer)
  }, [notifications, dismissNotification])

  if (notifications.length === 0) return null

  return (
    <div style={{
      position: 'fixed',
      bottom: 'var(--space-4)',
      right: 'var(--space-4)',
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-2)',
      maxWidth: 400,
    }}>
      {notifications.map((n) => (
        <div
          key={n.id}
          onClick={() => dismissNotification(n.id)}
          style={{
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            background: n.type === 'error' ? 'var(--reject)' : n.type === 'success' ? 'var(--accept)' : 'var(--accent)',
            color: '#fff',
            fontSize: 'var(--font-size-small)',
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            animation: 'fadeIn 0.2s ease-out',
          }}
        >
          {n.message}
        </div>
      ))}
    </div>
  )
}
