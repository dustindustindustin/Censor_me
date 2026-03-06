/**
 * FindingsPanel — left pane of the three-pane layout.
 *
 * Displays all RedactionEvents detected in the current project, with controls
 * to filter by PII type and status, sort by time or confidence, and
 * accept/reject individual findings.
 *
 * Each finding item shows:
 * - A color-coded PII type tag
 * - The detected text (or "[secure mode]" if stored_text is off)
 * - The time range
 * - Confidence percentage
 * - Accept/Reject buttons (visible only when the item is selected and pending)
 *
 * Keyboard shortcuts (A/R) operate on the selected event and are handled
 * by ``useKeyboard`` in VideoPreview, not here. This panel handles click-based
 * interactions only.
 */

import { useState } from 'react'
import { updateEventStatus } from '../../api/client'
import { useProjectStore } from '../../store/projectStore'
import type { EventStatus, PiiType, RedactionEvent } from '../../types'

/** Props for the FindingsPanel component. */
interface Props {
  /** Optional inline style overrides (e.g., width, flexShrink). */
  style?: React.CSSProperties
}

/** All valid PII types for the filter dropdown. */
const PII_TYPES: PiiType[] = [
  'phone', 'email', 'person', 'address', 'credit_card',
  'ssn', 'account_id', 'employee_id', 'postal_code', 'username', 'custom', 'manual', 'unknown',
]

/**
 * Left pane: filterable, sortable list of all detected PII events.
 *
 * Connects to the Zustand store for events and selection state. Calls the API
 * directly to persist accept/reject decisions.
 */
export function FindingsPanel({ style }: Props) {
  const { project, events, selectedEventId, selectEvent, updateEventStatus: updateLocal } =
    useProjectStore((s) => ({
      project: s.project,
      events: s.events,
      selectedEventId: s.selectedEventId,
      selectEvent: s.selectEvent,
      updateEventStatus: s.updateEventStatus,
    }))

  // Filter and sort state — local to this component (not persisted to project)
  const [filterType, setFilterType] = useState<PiiType | 'all'>('all')
  const [filterStatus, setFilterStatus] = useState<EventStatus | 'all'>('all')
  const [sortBy, setSortBy] = useState<'time' | 'confidence'>('time')

  // Apply filters and sort in a single pass
  const filtered = events
    .filter((e) => filterType === 'all' || e.pii_type === filterType)
    .filter((e) => filterStatus === 'all' || e.status === filterStatus)
    .sort((a, b) =>
      sortBy === 'confidence'
        ? b.confidence - a.confidence
        : (a.time_ranges[0]?.start_ms ?? 0) - (b.time_ranges[0]?.start_ms ?? 0)
    )

  /**
   * Accept or reject an event. Updates the local store immediately for
   * instant UI feedback, then persists to the backend.
   */
  const handleStatus = async (e: RedactionEvent, status: EventStatus) => {
    if (!project) return
    updateLocal(e.event_id, status)  // Optimistic update
    await updateEventStatus(project.project_id, e.event_id, status)
  }

  return (
    <div style={{ background: 'var(--surface)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', ...style }}>
      {/* ── Filters and sort controls ── */}
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>
          Findings ({filtered.length})
        </div>

        {/* PII type filter */}
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as PiiType | 'all')}
          style={{ width: '100%', marginBottom: 6 }}
          aria-label="Filter by PII type"
        >
          <option value="all">All types</option>
          {PII_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        <div style={{ display: 'flex', gap: 6 }}>
          {/* Status filter */}
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as EventStatus | 'all')}
            style={{ flex: 1 }}
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
          </select>

          {/* Sort order */}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'time' | 'confidence')}
            style={{ flex: 1 }}
            aria-label="Sort order"
          >
            <option value="time">Sort: Time</option>
            <option value="confidence">Sort: Confidence</option>
          </select>
        </div>
      </div>

      {/* ── Scrollable event list ── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 && (
          <div style={{ padding: 20, color: 'var(--text-muted)', textAlign: 'center', fontSize: 13 }}>
            {events.length === 0
              ? 'No findings yet. Import a video and click Scan.'
              : 'No findings match the current filters.'}
          </div>
        )}
        {filtered.map((event) => (
          <FindingItem
            key={event.event_id}
            event={event}
            selected={selectedEventId === event.event_id}
            onSelect={() => selectEvent(event.event_id)}
            onAccept={() => handleStatus(event, 'accepted')}
            onReject={() => handleStatus(event, 'rejected')}
          />
        ))}
      </div>
    </div>
  )
}

// ── FindingItem ───────────────────────────────────────────────────────────────

interface FindingItemProps {
  event: RedactionEvent
  selected: boolean
  /** Called when the user clicks anywhere on the item row. */
  onSelect: () => void
  /** Called when the Accept button is clicked. */
  onAccept: () => void
  /** Called when the Reject button is clicked. */
  onReject: () => void
}

/**
 * A single row in the findings list.
 *
 * Shows PII type, detected text, time range, and confidence. When selected,
 * expands to show Accept/Reject buttons (for pending events only).
 */
function FindingItem({ event, selected, onSelect, onAccept, onReject }: FindingItemProps) {
  // Use the first time range for the display timestamp
  const startMs = event.time_ranges[0]?.start_ms ?? 0
  const endMs = event.time_ranges[event.time_ranges.length - 1]?.end_ms ?? 0

  /** Format a millisecond timestamp as "M:SS". */
  const formatTime = (ms: number) => {
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    return `${m}:${String(s % 60).padStart(2, '0')}`
  }

  const statusColor =
    event.status === 'accepted' ? 'var(--accept)'
    : event.status === 'rejected' ? 'var(--reject)'
    : 'var(--pending)'

  return (
    <div
      onClick={onSelect}
      style={{
        padding: '10px 14px',
        borderBottom: '1px solid var(--border)',
        cursor: 'pointer',
        background: selected ? 'rgba(91, 124, 246, 0.12)' : 'transparent',
        // Blue left border indicates which finding is loaded in the Inspector
        borderLeft: selected ? '3px solid var(--accent)' : '3px solid transparent',
      }}
    >
      {/* Row header: type tag + status badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span className={`tag ${event.pii_type}`}>{event.pii_type}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: statusColor }}>
          {event.status}
        </span>
      </div>

      {/* Detected text (monospace for legibility of PII like phone numbers) */}
      <div style={{ fontFamily: 'monospace', fontSize: 12, marginBottom: 4, color: 'var(--text)' }}>
        {event.extracted_text ?? '[secure mode]'}
      </div>

      {/* Timestamp range + confidence score */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-muted)' }}>
        <span>{formatTime(startMs)} – {formatTime(endMs)}</span>
        <span>{Math.round(event.confidence * 100)}%</span>
      </div>

      {/* Accept/Reject buttons — only shown when this item is selected and still pending */}
      {selected && event.status === 'pending' && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button
            className="accept"
            onClick={(e) => { e.stopPropagation(); onAccept() }}
            style={{ flex: 1 }}
          >
            A — Accept
          </button>
          <button
            className="reject"
            onClick={(e) => { e.stopPropagation(); onReject() }}
            style={{ flex: 1 }}
          >
            R — Reject
          </button>
        </div>
      )}
    </div>
  )
}
