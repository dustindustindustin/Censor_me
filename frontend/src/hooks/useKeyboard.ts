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
import { updateEventStatus } from '../api/client'
import { useProjectStore } from '../store/projectStore'

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
  const { selectedEventId, updateEventStatus: updateLocal } = useProjectStore((s) => ({
    selectedEventId: s.selectedEventId,
    updateEventStatus: s.updateEventStatus,
  }))

  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      // Let the user type in form fields without triggering shortcuts
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

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
            // Optimistic update: UI responds instantly, API call follows
            updateLocal(selectedEventId, 'accepted')
            await updateEventStatus(projectId, selectedEventId, 'accepted')
          }
          break

        case 'r':
          if (selectedEventId) {
            updateLocal(selectedEventId, 'rejected')
            await updateEventStatus(projectId, selectedEventId, 'rejected')
          }
          break
      }
    }

    window.addEventListener('keydown', handler)
    // Remove listener on re-render (when selectedEventId or projectId changes)
    return () => window.removeEventListener('keydown', handler)
  }, [projectId, selectedEventId, videoRef, stepMs, updateLocal])
}
