import { useRef, useCallback } from 'react'

// Ported from probe src/components/shared/TextOverlay.jsx (Task 10).
// Nothing stripped — the probe file had no EventLogger/eventTypes/condition/
// webrtc references; it is a pure presentational + drag/keyboard component.

const FONT_SIZES = { S: '0.75rem', M: '1rem', L: '1.25rem' }

export default function TextOverlay({ overlay, isEditing, onMove }) {
  const dragRef = useRef(null)
  const parentRef = useRef(null)

  const handlePointerDown = useCallback((e) => {
    if (!isEditing) return
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    const parent = el.parentElement
    parentRef.current = parent
    const rect = parent.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    dragRef.current = {
      offsetX: e.clientX - elRect.left - elRect.width / 2,
      offsetY: e.clientY - elRect.top - elRect.height / 2,
      parentRect: rect,
    }
    el.setPointerCapture(e.pointerId)
  }, [isEditing])

  const handlePointerMove = useCallback((e) => {
    if (!dragRef.current) return
    e.preventDefault()
    const { parentRect } = dragRef.current
    const x = ((e.clientX - parentRect.left) / parentRect.width) * 100
    const y = ((e.clientY - parentRect.top) / parentRect.height) * 100
    const clampedX = Math.max(5, Math.min(95, x))
    const clampedY = Math.max(5, Math.min(95, y))
    e.currentTarget.style.left = `${clampedX}%`
    e.currentTarget.style.top = `${clampedY}%`
  }, [])

  const handlePointerUp = useCallback((e) => {
    if (!dragRef.current) return
    const { parentRect } = dragRef.current
    const x = ((e.clientX - parentRect.left) / parentRect.width) * 100
    const y = ((e.clientY - parentRect.top) / parentRect.height) * 100
    const clampedX = Math.max(5, Math.min(95, x))
    const clampedY = Math.max(5, Math.min(95, y))
    dragRef.current = null
    onMove(overlay.id, clampedX, clampedY)
  }, [overlay.id, onMove])

  const handleKeyDown = useCallback((e) => {
    if (!isEditing) return
    const STEP = 5
    let x = overlay.x
    let y = overlay.y
    switch (e.key) {
      case 'ArrowLeft': x -= STEP; break
      case 'ArrowRight': x += STEP; break
      case 'ArrowUp': y -= STEP; break
      case 'ArrowDown': y += STEP; break
      default: return
    }
    e.preventDefault()
    onMove(overlay.id, Math.max(5, Math.min(95, x)), Math.max(5, Math.min(95, y)))
  }, [isEditing, overlay.x, overlay.y, overlay.id, onMove])

  return (
    <div
      className={`absolute select-none ${isEditing ? 'cursor-move' : 'pointer-events-none'}`}
      style={{
        left: `${overlay.x}%`,
        top: `${overlay.y}%`,
        transform: 'translate(-50%, -50%)',
        fontSize: FONT_SIZES[overlay.size] || FONT_SIZES.M,
        color: overlay.color,
        textShadow: '1px 1px 2px rgba(0,0,0,0.8)',
        fontWeight: 700,
        padding: isEditing ? '8px 12px' : '4px 8px',
        minHeight: isEditing ? '44px' : undefined,
        minWidth: isEditing ? '44px' : undefined,
        border: isEditing ? '2px dashed #fbbf24' : 'none',
        backgroundColor: isEditing ? 'rgba(0,0,0,0.5)' : 'transparent',
        borderRadius: '4px',
        touchAction: 'none',
        zIndex: isEditing ? 10 : 1,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onKeyDown={isEditing ? handleKeyDown : undefined}
      tabIndex={isEditing ? 0 : undefined}
      aria-label={isEditing ? `Reposition text: ${overlay.content}. Use arrow keys to move.` : undefined}
      role={isEditing ? 'button' : undefined}
    >
      {overlay.content}
    </div>
  )
}
