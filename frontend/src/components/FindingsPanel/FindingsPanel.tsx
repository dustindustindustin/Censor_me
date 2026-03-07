/**
 * FindingsPanel — left pane of the three-pane layout.
 *
 * Displays all RedactionEvents detected in the current project, with controls
 * to filter by PII type and status, sort by time or confidence, and
 * accept/reject individual findings.
 */

import React, { useCallback, useMemo, useState } from 'react'
import { CircleDot, FilterX } from 'lucide-react'
import { bulkUpdateEventStatus, updateEventStatus } from '../../api/client'
import { useProjectStore } from '../../store/projectStore'
import type { EventStatus, PiiType, RedactionEvent } from '../../types'
import { formatMs } from '../../utils/format'

/** Props for the FindingsPanel component. */
interface Props {
  /** Optional inline style overrides (e.g., width, flexShrink). */
  style?: React.CSSProperties
}

/** All valid PII types for the filter dropdown. */
const PII_TYPES: PiiType[] = [
  'phone', 'email', 'person', 'address', 'credit_card',
  'ssn', 'account_id', 'employee_id', 'postal_code', 'username', 'face', 'custom', 'manual', 'unknown',
]

export function FindingsPanel({ style }: Props) {
  const {
    project, events, selectedEventId, selectEvent,
    updateEventStatus: updateLocal,
    bulkUpdateEventStatus: bulkUpdateLocal,
    scanProgress,
  } = useProjectStore((s) => ({
    project: s.project,
    events: s.events,
    selectedEventId: s.selectedEventId,
    selectEvent: s.selectEvent,
    updateEventStatus: s.updateEventStatus,
    bulkUpdateEventStatus: s.bulkUpdateEventStatus,
    scanProgress: s.scanProgress,
  }))

  // Filter and sort state — local to this component (not persisted to project)
  const [filterType, setFilterType] = useState<PiiType | 'all'>('all')
  const [filterStatus, setFilterStatus] = useState<EventStatus | 'all'>('all')
  const [sortBy, setSortBy] = useState<'time' | 'confidence'>('time')

  // Memoize filter + sort to avoid re-computing on every render
  const filtered = useMemo(() =>
    events
      .filter((e) => filterType === 'all' || e.pii_type === filterType)
      .filter((e) => filterStatus === 'all' || e.status === filterStatus)
      .sort((a, b) =>
        sortBy === 'confidence'
          ? b.confidence - a.confidence
          : (a.time_ranges[0]?.start_ms ?? 0) - (b.time_ranges[0]?.start_ms ?? 0)
      ),
    [events, filterType, filterStatus, sortBy],
  )

  const handleStatus = useCallback(async (e: RedactionEvent, status: EventStatus) => {
    if (!project) return
    updateLocal(e.event_id, status)
    await updateEventStatus(project.project_id, e.event_id, status)
  }, [project, updateLocal])

  const handleAcceptAll = async () => {
    if (!project) return
    const pendingIds = filtered.filter((e) => e.status === 'pending').map((e) => e.event_id)
    if (pendingIds.length === 0) return
    bulkUpdateLocal('accepted', pendingIds)
    await bulkUpdateEventStatus(project.project_id, 'accepted', pendingIds)
  }

  const handleRejectAll = async () => {
    if (!project || filtered.length === 0) return
    if (!window.confirm(`Reject all ${filtered.length} visible finding(s)?`)) return
    const ids = filtered.map((e) => e.event_id)
    bulkUpdateLocal('rejected', ids)
    await bulkUpdateEventStatus(project.project_id, 'rejected', ids)
  }

  return (
    <div className="glass" style={{ display: 'flex', flexDirection: 'column', borderRadius: 0, ...style }}>
      {/* ── Filters and sort controls ── */}
      <div style={{ padding: 'var(--space-4)', borderBottom: '1px solid var(--border-hairline)' }}>
        <div className="section-header" style={{ paddingBottom: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
          <span style={{ fontWeight: 600, fontSize: 'var(--font-size-body)' }}>Findings ({filtered.length})</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-1)' }}>
            <button
              className="accept"
              style={{ fontSize: 'var(--font-size-xs)', padding: 'var(--space-1) var(--space-2)', minHeight: 'auto' }}
              disabled={scanProgress.isRunning || filtered.filter((e) => e.status === 'pending').length === 0}
              onClick={handleAcceptAll}
              title="Accept all pending findings in the current filter"
            >
              Accept All
            </button>
            <button
              className="reject"
              style={{ fontSize: 'var(--font-size-xs)', padding: 'var(--space-1) var(--space-2)', minHeight: 'auto' }}
              disabled={scanProgress.isRunning || filtered.length === 0}
              onClick={handleRejectAll}
              title="Reject all visible findings in the current filter"
            >
              Reject All
            </button>
          </div>
        </div>

        {/* PII type filter */}
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as PiiType | 'all')}
          style={{ width: '100%', marginBottom: 'var(--space-2)', fontSize: 'var(--font-size-small)', minHeight: 32 }}
          aria-label="Filter by PII type"
        >
          <option value="all">All types</option>
          {PII_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        <div style={{ display: 'flex', gap: 'var(--space-2)', minWidth: 0 }}>
          {/* Status filter */}
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as EventStatus | 'all')}
            style={{ flex: 1, minWidth: 0, fontSize: 'var(--font-size-small)', minHeight: 32 }}
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
            style={{ flex: 1, minWidth: 0, fontSize: 'var(--font-size-small)', minHeight: 32 }}
            aria-label="Sort order"
          >
            <option value="time">By time</option>
            <option value="confidence">By confidence</option>
          </select>
        </div>
      </div>

      {/* ── Scrollable event list ── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 && (
          <div style={{ padding: 'var(--space-6)', color: 'var(--text-muted)', textAlign: 'center', fontSize: 'var(--font-size-body)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-2)' }}>
            <div style={{ opacity: 0.4 }}>
              {events.length === 0 ? <CircleDot size={32} /> : <FilterX size={32} />}
            </div>
            <div>{events.length === 0 ? 'No findings yet' : 'No matches'}</div>
            <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--text-disabled)' }}>
              {events.length === 0
                ? 'Import a video and click Scan to detect PII.'
                : 'Try adjusting your filters above.'}
            </div>
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
  onSelect: () => void
  onAccept: () => void
  onReject: () => void
}

const FindingItem = React.memo(function FindingItem({ event, selected, onSelect, onAccept, onReject }: FindingItemProps) {
  const startMs = event.time_ranges[0]?.start_ms ?? 0
  const endMs = event.time_ranges[event.time_ranges.length - 1]?.end_ms ?? 0

  const statusColor =
    event.status === 'accepted' ? 'var(--accept)'
    : event.status === 'rejected' ? 'var(--reject)'
    : 'var(--pending)'

  return (
    <div
      className="finding-item"
      data-selected={selected}
      onClick={onSelect}
    >
      {/* Row header: type tag + status badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-1)' }}>
        <span className={`tag ${event.pii_type}`}>{event.pii_type}</span>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-xs)', color: statusColor, fontWeight: 500 }}>
          {event.status}
        </span>
      </div>

      {/* Detected text */}
      <div style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-small)', marginBottom: 'var(--space-1)', color: 'var(--text)' }}>
        {event.extracted_text ?? '[secure mode]'}
      </div>

      {/* Timestamp range + confidence score + style badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
        <span>{formatMs(startMs)} \u2013 {formatMs(endMs)}</span>
        <span>{Math.round(event.confidence * 100)}%</span>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-xs)', padding: '1px 5px', borderRadius: 'var(--radius-sm)', background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
          {event.redaction_style.type === 'solid_box' ? 'box' : event.redaction_style.type}
        </span>
      </div>

      {/* Accept/Reject buttons — only shown when this item is selected and still pending */}
      {selected && event.status === 'pending' && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
          <button
            className="accept"
            onClick={(e) => { e.stopPropagation(); onAccept() }}
            style={{ flex: 1, fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-2)', minHeight: 28 }}
          >
            A \u2014 Accept
          </button>
          <button
            className="reject"
            onClick={(e) => { e.stopPropagation(); onReject() }}
            style={{ flex: 1, fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-2)', minHeight: 28 }}
          >
            R \u2014 Reject
          </button>
        </div>
      )}
    </div>
  )
})
