/**
 * useKeyboard — global keyboard shortcut handler for the review workflow.
 *
 * Registers keyboard event listeners on the window for the standard video
 * editing and review shortcuts defined in the spec:
 *
 * | Key   | Action                          |
 * |-------|---------------------------------|
 * | Space | Play / Pause                    |
 * | J     | Step backward (−stepMs)         |
 * | K     | Pause                           |
 * | L     | Step forward (+stepMs)          |
 * | A     | Accept the selected finding     |
 * | R     | Reject the selected finding     |
 *
 * Shortcuts are suppressed when focus is inside an input or textarea element
 * so that the user can type in form fields without accidentally triggering them.
 *
 * The A and R shortcuts update both the local Zustand store (for instant
 * optimistic feedback) and the backend API (to persist the change).
 *
 * @example
 * ```tsx
 * const videoRef = useRef<HTMLVideoElement>(null)
 * useKeyboard({ projectId: 'abc-123', videoRef })
 * ```
 */

import { useEffect } from 'react'
import { bulkUpdateEventStatus, bulkUpdateEventStyle, updateEventKeyframes, updateEventStatus, updateEventStyle } from '../api/client'
import { useProjectStore } from '../store/projectStore'
import type { UndoAction } from '../store/projectStore'

/** Options for the useKeyboard hook. */
interface KeyboardOptions {
  /** The project ID used when persisting accept/reject decisions to the API. */
  projectId: string
  /** Ref to the video element, used to control playback and current time. */
  videoRef: React.RefObject<HTMLVideoElement>
  /**
   * How many milliseconds to jump when J or L is pressed.
   * @default 5000 (5 seconds)
   */
  stepMs?: number
}

/**
 * Register global keyboard shortcuts for video review.
 *
 * @param options - See ``KeyboardOptions``.
 */
export function useKeyboard({ projectId, videoRef, stepMs = 5000 }: KeyboardOptions): void {
  const { selectedEventId, events, updateEventStatus: updateLocal, undo, redo, pushUndo } = useProjectStore((s) => ({
    selectedEventId: s.selectedEventId,
    events: s.events,
    updateEventStatus: s.updateEventStatus,
    undo: s.undo,
    redo: s.redo,
    pushUndo: s.pushUndo,
  }))

  useEffect(() => {
    /** Persist the state change from an undo/redo action to the backend. */
    const persistUndoRedo = async (action: UndoAction, snapshot: 'before' | 'after') => {
      const data = snapshot === 'before' ? action.before : action.after
      switch (action.type) {
        case 'status':
          if (action.eventId) await updateEventStatus(projectId, action.eventId, data.status)
          break
        case 'style':
          if (action.eventId) await updateEventStyle(projectId, action.eventId, data.style)
          break
        case 'keyframes':
          if (action.eventId) await updateEventKeyframes(projectId, action.eventId, data.keyframes)
          break
        case 'add_event':
          // Undo add = delete; Redo add = re-add. For now, we rely on the event
          // list being saved on next project save. A dedicated delete endpoint
          // would be needed for full backend sync.
          break
        case 'bulk_status':
          if (snapshot === 'before') {
            // Undo: restore each event's individual status — bulk update per unique status
            const statusGroups = new Map<string, string[]>()
            const beforeMap = data as Map<string, string>
            for (const [eid, status] of beforeMap) {
              const list = statusGroups.get(status) ?? []
              list.push(eid)
              statusGroups.set(status, list)
            }
            for (const [status, ids] of statusGroups) {
              await bulkUpdateEventStatus(projectId, status as any, ids)
            }
          } else {
            await bulkUpdateEventStatus(projectId, data.status, action.eventIds)
          }
          break
        case 'bulk_style':
          if (snapshot === 'before') {
            // Undo: restore each event's individual style — update each one
            const beforeMap = data as Map<string, import('../types').RedactionStyle>
            for (const [eid, style] of beforeMap) {
              await updateEventStyle(projectId, eid, style)
            }
          } else {
            await bulkUpdateEventStyle(projectId, data.style, action.eventIds)
          }
          break
      }
    }

    const handler = async (e: KeyboardEvent) => {
      // Let the user type in form fields without triggering shortcuts
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      // Undo: Ctrl+Z (or Cmd+Z on Mac)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        const action = undo()
        if (action) persistUndoRedo(action, 'before').catch(console.error)
        return
      }

      // Redo: Ctrl+Y or Ctrl+Shift+Z (or Cmd equivalents)
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault()
        const action = redo()
        if (action) persistUndoRedo(action, 'after').catch(console.error)
        return
      }

      const video = videoRef.current

      switch (e.key.toLowerCase()) {
        case ' ':
          e.preventDefault() // Prevent page scroll on Space
          if (video) video.paused ? video.play() : video.pause()
          break

        case 'k':
          video?.pause()
          break

        case 'j':
          // Step backward, clamped to start of video
          if (video) video.currentTime = Math.max(0, video.currentTime - stepMs / 1000)
          break

        case 'l':
          // Step forward, clamped to end of video
          if (video) video.currentTime = Math.min(video.duration, video.currentTime + stepMs / 1000)
          break

        case 'a':
          if (selectedEventId) {
            const ev = events.find((e) => e.event_id === selectedEventId)
            if (ev) pushUndo({ type: 'status', eventId: selectedEventId, before: { status: ev.status }, after: { status: 'accepted' } })
            updateLocal(selectedEventId, 'accepted')
            await updateEventStatus(projectId, selectedEventId, 'accepted')
          }
          break

        case 'r':
          if (selectedEventId) {
            const ev = events.find((e) => e.event_id === selectedEventId)
            if (ev) pushUndo({ type: 'status', eventId: selectedEventId, before: { status: ev.status }, after: { status: 'rejected' } })
            updateLocal(selectedEventId, 'rejected')
            await updateEventStatus(projectId, selectedEventId, 'rejected')
          }
          break
      }
    }

    window.addEventListener('keydown', handler)
    // Remove listener on re-render (when selectedEventId or projectId changes)
    return () => window.removeEventListener('keydown', handler)
  }, [projectId, selectedEventId, events, videoRef, stepMs, updateLocal, undo, redo, pushUndo])
}
