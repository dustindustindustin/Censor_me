/**
 * FindingsPanel — left pane of the three-pane layout.
 *
 * Displays all RedactionEvents detected in the current project, with controls
 * to filter by PII type and status, sort by time or confidence, group duplicate
 * findings by text, and accept/reject/reset individual or grouped findings.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, CircleDot, FilterX, Layers } from 'lucide-react'
import { bulkUpdateEventStatus, updateEventStatus } from '../../api/client'
import { useProjectStore } from '../../store/projectStore'
import type { EventStatus, PiiType, RedactionEvent } from '../../types'
import { formatMs } from '../../utils/format'

interface Props {
  style?: React.CSSProperties
}

const PII_TYPES: PiiType[] = [
  'phone', 'email', 'person', 'address', 'credit_card',
  'ssn', 'account_id', 'employee_id', 'postal_code', 'username', 'face', 'custom', 'manual', 'unknown',
]

// Group key: pii_type + normalized extracted_text so "Dustin" at time 0:01 and 0:05 share a group
const groupKey = (e: RedactionEvent) =>
  `${e.pii_type}::${(e.extracted_text ?? '').toLowerCase().trim()}`

type GroupStatus = EventStatus | 'mixed'

function getGroupStatus(events: RedactionEvent[]): GroupStatus {
  const statuses = new Set(events.map((e) => e.status))
  if (statuses.size === 1) return events[0].status
  return 'mixed'
}

export function FindingsPanel({ style }: Props) {
  const {
    project, events, selectedEventId, selectEvent,
    updateEventStatus: updateLocal,
    bulkUpdateEventStatus: bulkUpdateLocal,
    scanProgress,
    pushUndo,
    addNotification,
  } = useProjectStore((s) => ({
    project: s.project,
    events: s.events,
    selectedEventId: s.selectedEventId,
    selectEvent: s.selectEvent,
    updateEventStatus: s.updateEventStatus,
    bulkUpdateEventStatus: s.bulkUpdateEventStatus,
    scanProgress: s.scanProgress,
    pushUndo: s.pushUndo,
    addNotification: s.addNotification,
  }))

  const [filterType, setFilterType] = useState<PiiType | 'all'>('all')
  const [filterStatus, setFilterStatus] = useState<EventStatus | 'all'>('all')
  const [sortBy, setSortBy] = useState<'time' | 'confidence'>('time')
  const [groupByText, setGroupByText] = useState(true)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

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

  const groups = useMemo(() => {
    if (!groupByText) return null
    const map = new Map<string, RedactionEvent[]>()
    for (const e of filtered) {
      const key = groupKey(e)
      const list = map.get(key) ?? []
      list.push(e)
      map.set(key, list)
    }
    return [...map.entries()].map(([key, evts]) => ({ key, events: evts }))
  }, [filtered, groupByText])

  // Auto-expand the group that contains the currently selected event
  useEffect(() => {
    if (!selectedEventId || !groupByText) return
    const ev = events.find((e) => e.event_id === selectedEventId)
    if (!ev) return
    const key = groupKey(ev)
    setExpandedGroups((prev) => {
      if (prev.has(key)) return prev
      return new Set([...prev, key])
    })
  }, [selectedEventId, groupByText, events])

  const handleStatus = useCallback(async (e: RedactionEvent, status: EventStatus) => {
    if (!project) return
    const previousStatus = e.status
    pushUndo({ type: 'status', eventId: e.event_id, before: { status: e.status }, after: { status } })
    updateLocal(e.event_id, status)
    try {
      await updateEventStatus(project.project_id, e.event_id, status)
    } catch {
      updateLocal(e.event_id, previousStatus)
      addNotification('Failed to save status change — please try again.', 'error')
    }
  }, [project, updateLocal, pushUndo, addNotification])

  const handleGroupStatus = useCallback(async (groupEvents: RedactionEvent[], status: EventStatus) => {
    if (!project) return
    const ids = groupEvents.map((e) => e.event_id)
    const previousStatuses = new Map(groupEvents.map((e) => [e.event_id, e.status]))
    const beforeMap = new Map(groupEvents.map((e) => [e.event_id, e.status]))
    pushUndo({ type: 'bulk_status', eventIds: ids, before: beforeMap, after: { status } })
    bulkUpdateLocal(status, ids)
    try {
      await bulkUpdateEventStatus(project.project_id, status, ids)
    } catch {
      for (const [id, prev] of previousStatuses) updateLocal(id, prev)
      addNotification('Failed to save status changes — please try again.', 'error')
    }
  }, [project, updateLocal, bulkUpdateLocal, pushUndo, addNotification])

  const handleAcceptAll = async () => {
    if (!project) return
    const pendingEvents = filtered.filter((e) => e.status === 'pending')
    if (pendingEvents.length === 0) return
    const ids = pendingEvents.map((e) => e.event_id)
    const previousStatuses = new Map(pendingEvents.map((e) => [e.event_id, e.status]))
    const beforeMap = new Map(pendingEvents.map((e) => [e.event_id, e.status]))
    pushUndo({ type: 'bulk_status', eventIds: ids, before: beforeMap, after: { status: 'accepted' } })
    bulkUpdateLocal('accepted', ids)
    try {
      await bulkUpdateEventStatus(project.project_id, 'accepted', ids)
    } catch {
      for (const [id, prev] of previousStatuses) updateLocal(id, prev)
      addNotification('Failed to accept findings — please try again.', 'error')
    }
  }

  const handleRejectAll = async () => {
    if (!project || filtered.length === 0) return
    if (!window.confirm(`Reject all ${filtered.length} visible finding(s)?`)) return
    const ids = filtered.map((e) => e.event_id)
    const previousStatuses = new Map(filtered.map((e) => [e.event_id, e.status]))
    const beforeMap = new Map(filtered.map((e) => [e.event_id, e.status]))
    pushUndo({ type: 'bulk_status', eventIds: ids, before: beforeMap, after: { status: 'rejected' } })
    bulkUpdateLocal('rejected', ids)
    try {
      await bulkUpdateEventStatus(project.project_id, 'rejected', ids)
    } catch {
      for (const [id, prev] of previousStatuses) updateLocal(id, prev)
      addNotification('Failed to reject findings — please try again.', 'error')
    }
  }

  const toggleGroup = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const pendingCount = events.filter((e) => e.status === 'pending').length
  const acceptedCount = events.filter((e) => e.status === 'accepted').length
  const rejectedCount = events.filter((e) => e.status === 'rejected').length

  const groupCount = groups?.length ?? filtered.length
  const countLabel = groupByText && groups && groupCount !== filtered.length
    ? `${filtered.length} · ${groupCount} group${groupCount !== 1 ? 's' : ''}`
    : `${filtered.length}`

  return (
    <div className="glass" style={{ display: 'flex', flexDirection: 'column', borderRadius: 0, ...style }}>
      {/* ── Header ── */}
      <div style={{ padding: 'var(--space-4)', borderBottom: '1px solid var(--border-hairline)' }}>
        <div className="section-header" style={{ paddingBottom: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
          <span style={{ fontWeight: 600, fontSize: 'var(--font-size-body)' }}>
            Findings <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 'var(--font-size-small)' }}>({countLabel})</span>
          </span>
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

        {/* Status breakdown */}
        {events.length > 0 && (
          <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-2)', fontSize: 'var(--font-size-xs)' }}>
            <span style={{ color: 'var(--pending)' }}>● {pendingCount} pending</span>
            <span style={{ color: 'var(--accept)' }}>✓ {acceptedCount} accepted</span>
            <span style={{ color: 'var(--reject)' }}>✕ {rejectedCount} rejected</span>
          </div>
        )}

        {/* Group toggle */}
        <div style={{ marginTop: 'var(--space-2)', display: 'flex', justifyContent: 'flex-end' }}>
          <button
            className="ghost toolbar-toggle"
            data-active={groupByText}
            onClick={() => setGroupByText((v) => !v)}
            style={{ fontSize: 'var(--font-size-xs)', minHeight: 'auto', padding: 'var(--space-1) var(--space-2)', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}
            title={groupByText ? 'Show as flat list' : 'Group duplicate findings together'}
          >
            <Layers size={12} /> Group duplicates
          </button>
        </div>
      </div>

      {/* ── Scrollable list ── */}
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

        {groupByText && groups ? (
          groups.map(({ key, events: groupEvents }) => (
            <FindingGroup
              key={key}
              events={groupEvents}
              selectedEventId={selectedEventId}
              isExpanded={groupEvents.length === 1 || expandedGroups.has(key)}
              onToggleExpand={() => toggleGroup(key)}
              onSelect={selectEvent}
              onStatusChange={handleStatus}
              onGroupStatus={(status) => handleGroupStatus(groupEvents, status)}
            />
          ))
        ) : (
          filtered.map((event) => (
            <FindingItem
              key={event.event_id}
              event={event}
              selected={selectedEventId === event.event_id}
              onSelect={() => selectEvent(event.event_id)}
              onStatusChange={(status) => handleStatus(event, status)}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ── FindingGroup ──────────────────────────────────────────────────────────────

interface FindingGroupProps {
  events: RedactionEvent[]
  selectedEventId: string | null
  isExpanded: boolean
  onToggleExpand: () => void
  onSelect: (id: string) => void
  onStatusChange: (event: RedactionEvent, status: EventStatus) => void
  onGroupStatus: (status: EventStatus) => void
}

const FindingGroup = React.memo(function FindingGroup({
  events, selectedEventId, isExpanded, onToggleExpand, onSelect, onStatusChange, onGroupStatus,
}: FindingGroupProps) {
  const rep = events[0]
  const isMulti = events.length > 1
  const groupSt = getGroupStatus(events)
  const anySelected = events.some((e) => e.event_id === selectedEventId)

  const statusColor =
    groupSt === 'accepted' ? 'var(--accept)'
    : groupSt === 'rejected' ? 'var(--reject)'
    : 'var(--pending)'

  const statusLabel =
    groupSt === 'mixed'
      ? `${events.filter((e) => e.status === 'accepted').length}/${events.length} accepted`
      : groupSt

  return (
    <div style={{ borderBottom: '1px solid var(--border-hairline)' }}>
      {/* Group header row */}
      <div
        className="finding-item"
        data-selected={anySelected}
        onClick={() => isMulti ? onToggleExpand() : onSelect(rep.event_id)}
        style={{ borderBottom: 'none', cursor: 'pointer' }}
      >
        {/* Top row: chevron + type tag + count + status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-1)' }}>
          {isMulti && (
            <span style={{ color: 'var(--text-muted)', flexShrink: 0, lineHeight: 1 }}>
              {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          )}
          <span className={`tag ${rep.pii_type}`}>{rep.pii_type}</span>
          {isMulti && (
            <span style={{
              fontSize: 'var(--font-size-xs)', fontWeight: 600,
              background: 'var(--bg)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)', padding: '0 5px', color: 'var(--text-muted)',
            }}>
              ×{events.length}
            </span>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-xs)', color: statusColor, fontWeight: 500 }}>
            {statusLabel}
          </span>
        </div>

        {/* Detected text */}
        <div style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-small)', marginBottom: 'var(--space-1)', color: 'var(--text)' }}>
          {rep.extracted_text ?? '(text not stored)'}
        </div>

        {/* For single-event groups: show the time range inline */}
        {!isMulti && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginBottom: 'var(--space-1)' }}>
            <span>{formatMs(rep.time_ranges[0]?.start_ms ?? 0)} – {formatMs(rep.time_ranges[rep.time_ranges.length - 1]?.end_ms ?? 0)}</span>
            <span>{Math.round(rep.confidence * 100)}%</span>
            <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-xs)', padding: '1px 5px', borderRadius: 'var(--radius-sm)', background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
              {rep.redaction_style.type === 'solid_box' ? 'box' : rep.redaction_style.type}
            </span>
          </div>
        )}

        {/* Group action buttons — always visible */}
        <div style={{ display: 'flex', gap: 'var(--space-1)', marginTop: 'var(--space-1)' }} onClick={(e) => e.stopPropagation()}>
          <button
            className="accept"
            onClick={() => onGroupStatus('accepted')}
            style={{ flex: 1, fontSize: 'var(--font-size-xs)', padding: '3px 6px', minHeight: 26, opacity: groupSt === 'accepted' ? 1 : 0.65 }}
          >
            {isMulti ? 'Accept All' : (groupSt === 'accepted' ? '✓ Accepted' : 'Accept')}
          </button>
          <button
            onClick={() => onGroupStatus('pending')}
            style={{
              flex: 1, fontSize: 'var(--font-size-xs)', padding: '3px 6px', minHeight: 26,
              background: 'var(--glass-bg)',
              color: groupSt === 'pending' || groupSt === 'mixed' ? 'var(--pending)' : 'var(--text-muted)',
              border: `1px solid ${groupSt === 'pending' || groupSt === 'mixed' ? 'var(--pending)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-md)', cursor: 'pointer',
              opacity: groupSt === 'pending' ? 1 : 0.65,
            }}
          >
            {groupSt === 'pending' ? '● Pending' : 'Reset'}
          </button>
          <button
            className="reject"
            onClick={() => onGroupStatus('rejected')}
            style={{ flex: 1, fontSize: 'var(--font-size-xs)', padding: '3px 6px', minHeight: 26, opacity: groupSt === 'rejected' ? 1 : 0.65 }}
          >
            {isMulti ? 'Reject All' : (groupSt === 'rejected' ? '✕ Rejected' : 'Reject')}
          </button>
        </div>
      </div>

      {/* Expanded individual instances (multi-event groups only) */}
      {isMulti && isExpanded && events.map((event, idx) => (
        <GroupInstanceItem
          key={event.event_id}
          event={event}
          selected={selectedEventId === event.event_id}
          isLast={idx === events.length - 1}
          onSelect={() => onSelect(event.event_id)}
          onStatusChange={(status) => onStatusChange(event, status)}
        />
      ))}
    </div>
  )
})

// ── GroupInstanceItem — a single occurrence inside an expanded group ───────────

interface GroupInstanceItemProps {
  event: RedactionEvent
  selected: boolean
  isLast: boolean
  onSelect: () => void
  onStatusChange: (status: EventStatus) => void
}

const GroupInstanceItem = React.memo(function GroupInstanceItem({
  event, selected, isLast, onSelect, onStatusChange,
}: GroupInstanceItemProps) {
  const startMs = event.time_ranges[0]?.start_ms ?? 0
  const endMs = event.time_ranges[event.time_ranges.length - 1]?.end_ms ?? 0

  const statusColor =
    event.status === 'accepted' ? 'var(--accept)'
    : event.status === 'rejected' ? 'var(--reject)'
    : 'var(--pending)'

  return (
    <div
      onClick={onSelect}
      style={{
        padding: 'var(--space-2) var(--space-3) var(--space-2) var(--space-6)',
        background: selected ? 'rgba(216,27,96,0.07)' : 'transparent',
        borderBottom: isLast ? 'none' : '1px solid var(--border-hairline)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        fontSize: 'var(--font-size-xs)',
        transition: 'background var(--transition-fast)',
      }}
    >
      <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace', flex: 1, whiteSpace: 'nowrap' }}>
        {formatMs(startMs)} – {formatMs(endMs)}
      </span>
      <span style={{ color: statusColor, fontWeight: 500, minWidth: 50 }}>{event.status}</span>
      {selected && (
        <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <StatusMiniButton
            active={event.status === 'accepted'}
            color="var(--accept)"
            label="✓"
            title="Accept"
            onClick={() => onStatusChange('accepted')}
          />
          <StatusMiniButton
            active={event.status === 'pending'}
            color="var(--pending)"
            label="●"
            title="Reset to pending"
            onClick={() => onStatusChange('pending')}
          />
          <StatusMiniButton
            active={event.status === 'rejected'}
            color="var(--reject)"
            label="✕"
            title="Reject"
            onClick={() => onStatusChange('rejected')}
          />
        </div>
      )}
    </div>
  )
})

function StatusMiniButton({ active, color, label, title, onClick }: {
  active: boolean; color: string; label: string; title: string; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        fontSize: 10, padding: '2px 6px', minHeight: 20, minWidth: 22,
        background: active ? color : 'var(--glass-bg)',
        color: active ? (color === 'var(--pending)' ? '#000' : '#fff') : color,
        border: `1px solid ${active ? color : 'var(--border)'}`,
        borderRadius: 'var(--radius-sm)', cursor: 'pointer',
        transition: 'all var(--transition-fast)',
      }}
    >
      {label}
    </button>
  )
}

// ── FindingItem — used in flat (non-grouped) view ─────────────────────────────

interface FindingItemProps {
  event: RedactionEvent
  selected: boolean
  onSelect: () => void
  onStatusChange: (status: EventStatus) => void
}

const FindingItem = React.memo(function FindingItem({ event, selected, onSelect, onStatusChange }: FindingItemProps) {
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-1)' }}>
        <span className={`tag ${event.pii_type}`}>{event.pii_type}</span>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-xs)', color: statusColor, fontWeight: 500 }}>
          {event.status}
        </span>
      </div>

      <div style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-small)', marginBottom: 'var(--space-1)', color: 'var(--text)' }}>
        {event.extracted_text ?? '(text not stored)'}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
        <span>{formatMs(startMs)} – {formatMs(endMs)}</span>
        <span>{Math.round(event.confidence * 100)}%</span>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-xs)', padding: '1px 5px', borderRadius: 'var(--radius-sm)', background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
          {event.redaction_style.type === 'solid_box' ? 'box' : event.redaction_style.type}
        </span>
      </div>

      {/* 3-way status toggle — visible when selected, regardless of current status */}
      {selected && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
          <button
            className="accept"
            onClick={(e) => { e.stopPropagation(); onStatusChange('accepted') }}
            style={{ flex: 1, fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-2)', minHeight: 28, opacity: event.status === 'accepted' ? 1 : 0.55 }}
          >
            {event.status === 'accepted' ? '✓ Accepted' : 'A — Accept'}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onStatusChange('pending') }}
            style={{
              flex: 1, fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-2)', minHeight: 28,
              background: 'var(--glass-bg)',
              color: event.status === 'pending' ? 'var(--pending)' : 'var(--text-muted)',
              border: `1px solid ${event.status === 'pending' ? 'var(--pending)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-md)', cursor: 'pointer',
              opacity: event.status === 'pending' ? 1 : 0.55,
            }}
          >
            {event.status === 'pending' ? '● Pending' : 'Reset'}
          </button>
          <button
            className="reject"
            onClick={(e) => { e.stopPropagation(); onStatusChange('rejected') }}
            style={{ flex: 1, fontSize: 'var(--font-size-small)', padding: 'var(--space-1) var(--space-2)', minHeight: 28, opacity: event.status === 'rejected' ? 1 : 0.55 }}
          >
            {event.status === 'rejected' ? '✕ Rejected' : 'R — Reject'}
          </button>
        </div>
      )}
    </div>
  )
})
