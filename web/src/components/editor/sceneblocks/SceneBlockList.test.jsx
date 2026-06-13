import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// House mock style (see HelperDevice.test.jsx): hoist + mock the announcer and
// the TTS singleton so jsdom never touches the live region or speechSynthesis.
const { mockAnnounce, ttsStop } = vi.hoisted(() => ({
  mockAnnounce: vi.fn(),
  ttsStop: vi.fn(),
}))
vi.mock('../../../utils/announcer.js', () => ({ announce: mockAnnounce }))
vi.mock('../../../services/ttsService.js', () => ({
  default: { stop: ttsStop, speak: vi.fn() },
}))

import SceneBlockList from './SceneBlockList'
import DetailLevelSelector from './DetailLevelSelector'

// Scene shape consumed by the list (see SceneBlockList.jsx header): snake_case
// time fields + `level_N` description keys. Task 3 builds this from state.clips.
const SCENES = [
  {
    id: 's1',
    name: 'Scene 1',
    color: '#9B59B6',
    start_time: 0,
    end_time: 6,
    descriptions: {
      level_1: 'A person stirs a pot.',
      level_2: 'A person slowly stirs a steaming pot on a stove.',
      level_3: 'Medium shot, 50mm, a person stirs a copper pot over a gas flame.',
    },
  },
  {
    id: 's2',
    name: 'Scene 2',
    color: '#E67E22',
    start_time: 6,
    end_time: 12,
    descriptions: {
      level_1: 'They taste the food.',
      level_2: 'They lift the spoon and taste the food, nodding.',
      level_3: 'Close-up, the cook tastes from a wooden spoon and nods approvingly.',
    },
  },
  {
    id: 's3',
    name: 'Scene 3',
    color: '#2ECC71',
    start_time: 12,
    end_time: 16,
    descriptions: {
      level_1: 'A dog runs by.',
      level_2: 'A small dog runs across the kitchen floor.',
      level_3: 'Wide shot, a terrier dashes left-to-right across the tiled floor.',
    },
  },
]

// Mirror how Task 2/3 compose the per-scene actions: the DetailLevelSelector
// lives INSIDE renderSceneActions (the probe renders it in Probe2bSceneActions),
// fed currentLevel/onLevelChange from the list.
function renderActions({ currentLevel, onLevelChange }) {
  return (
    <div>
      <DetailLevelSelector currentLevel={currentLevel} onLevelChange={onLevelChange} />
      <p data-testid="actions-marker">Per-scene actions for level {currentLevel}</p>
    </div>
  )
}

function renderList(overrides = {}) {
  const props = {
    scenes: SCENES,
    currentTime: 0,
    isPlaying: false,
    onSeek: vi.fn(),
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onSceneClose: vi.fn(),
    renderSceneActions: renderActions,
    ...overrides,
  }
  const utils = render(<SceneBlockList {...props} />)
  return { props, ...utils }
}

// The collapsed header button carries data-scene-index; its visible label
// "Scene N" lives inside it. Grab the header for scene N (0-based).
function headerForScene(n) {
  return document.querySelector(`button[data-scene-index="${n}"]`)
}

beforeEach(() => {
  vi.clearAllMocks()
  // jsdom: getBoundingClientRect is all-zeros, performance.now exists. The
  // history API is present. Reset history state between tests is not strictly
  // necessary for these assertions.
})

describe('SceneBlockList — rendering', () => {
  it('renders one collapsed block per scene', () => {
    renderList()
    expect(headerForScene(0)).toBeInTheDocument()
    expect(headerForScene(1)).toBeInTheDocument()
    expect(headerForScene(2)).toBeInTheDocument()
    expect(document.querySelectorAll('button[data-scene-index]')).toHaveLength(3)
  })

  it('the collapsed header shows the current-level description (level 1 by default)', () => {
    renderList()
    // Description is rendered (aria-hidden) inside the header; level 1 default.
    expect(within(headerForScene(0)).getByText('A person stirs a pot.')).toBeInTheDocument()
    expect(within(headerForScene(1)).getByText('They taste the food.')).toBeInTheDocument()
  })

  it('renders the empty-state message when there are no scenes', () => {
    renderList({ scenes: [] })
    expect(screen.getByText(/no scenes loaded/i)).toBeInTheDocument()
  })
})

describe('SceneBlockList — expand / collapse', () => {
  it('expanding a block reveals the DetailLevelSelector and the per-scene actions', async () => {
    renderList()
    // No actions region before expand.
    expect(screen.queryByTestId('actions-marker')).not.toBeInTheDocument()

    await userEvent.click(headerForScene(0))

    // Actions region for scene 0 is mounted, with the detail picker inside it.
    const region = document.querySelector('[data-scene-actions-region="0"]')
    expect(region).toBeInTheDocument()
    expect(within(region).getByTestId('actions-marker')).toBeInTheDocument()
    expect(within(region).getByRole('button', { name: /change to overview description/i })).toBeInTheDocument()
    expect(within(region).getByRole('button', { name: /change to detailed description/i })).toBeInTheDocument()
    expect(within(region).getByRole('button', { name: /change to technical description/i })).toBeInTheDocument()
  })

  it('expanding seeks to the scene start', async () => {
    const { props } = renderList()
    await userEvent.click(headerForScene(1))
    expect(props.onSeek).toHaveBeenCalledWith(6)
  })

  it('picking level 2 swaps the shown description to the level-2 text', async () => {
    renderList()
    await userEvent.click(headerForScene(0))
    // Level 1 text present.
    expect(within(headerForScene(0)).getByText('A person stirs a pot.')).toBeInTheDocument()

    const region = document.querySelector('[data-scene-actions-region="0"]')
    await userEvent.click(within(region).getByRole('button', { name: /change to detailed description/i }))

    // Header description now reflects level 2.
    expect(within(headerForScene(0)).getByText('A person slowly stirs a steaming pot on a stove.')).toBeInTheDocument()
    expect(within(headerForScene(0)).queryByText('A person stirs a pot.')).not.toBeInTheDocument()
    // The picker's pressed state moved to Detailed.
    expect(within(region).getByRole('button', { name: /change to detailed description/i }))
      .toHaveAttribute('aria-pressed', 'true')
  })

  it('collapsing via Back fires onSceneClose with the scene id', async () => {
    const { props } = renderList()
    await userEvent.click(headerForScene(0))
    const region = document.querySelector('[data-scene-actions-region="0"]')
    await userEvent.click(within(region).getByRole('button', { name: /back to scene description/i }))

    // onSceneClose runs in a rAF on the collapse transition.
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r()))
    })
    expect(props.onSceneClose).toHaveBeenCalledWith('s1')
    expect(document.querySelector('[data-scene-actions-region="0"]')).not.toBeInTheDocument()
  })
})

describe('SceneBlockList — edit stamps', () => {
  it('an editedScenes entry renders the amber "Edited" badge and the "What changed" line', () => {
    renderList({
      editedScenes: { s2: { text: 'Brightness +15', actor: 'helper', timestamp: 1 } },
    })
    const header = headerForScene(1)
    // Badge.
    expect(within(header).getByText('Edited')).toBeInTheDocument()
    // "What changed:" line + the diff text.
    expect(within(header).getByText(/what changed:/i)).toBeInTheDocument()
    expect(within(header).getAllByText(/Brightness \+15/).length).toBeGreaterThan(0)
    // The un-edited scene has no badge.
    expect(within(headerForScene(0)).queryByText('Edited')).not.toBeInTheDocument()
  })
})

describe('SceneBlockList — kept scenes', () => {
  it('a not-kept scene (keptScenes[id] === false) is dropped from the list', () => {
    renderList({ keptScenes: { s2: false } })
    // s2 (index 1) is removed entirely; s1 and s3 remain.
    const headers = document.querySelectorAll('button[data-scene-index]')
    expect(headers).toHaveLength(2)
    expect(within(headers[0]).getByText('Scene 1')).toBeInTheDocument()
    expect(within(headers[1]).getByText('Scene 3')).toBeInTheDocument()
    expect(screen.queryByText('Scene 2')).not.toBeInTheDocument()
  })

  it('the scroll group aria-label counts only kept scenes', () => {
    renderList({ keptScenes: { s2: false } })
    expect(screen.getByRole('group', { name: '2 scenes' })).toBeInTheDocument()
  })
})

describe('SceneBlockList — auto-follow', () => {
  it('expands the scene under the playhead when playback starts and disableAutoFollow is false', () => {
    const { rerender, props } = renderList({ currentTime: 0, isPlaying: false })
    // Start playback with the playhead inside scene 2 (6..12).
    rerender(<SceneBlockList {...props} currentTime={8} isPlaying />)
    // Scene index 1 (Scene 2) auto-expands.
    expect(document.querySelector('[data-scene-actions-region="1"]')).toBeInTheDocument()
  })

  it('does NOT auto-expand when disableAutoFollow is true', () => {
    const { rerender, props } = renderList({ currentTime: 0, isPlaying: false, disableAutoFollow: true })
    rerender(<SceneBlockList {...props} currentTime={8} isPlaying disableAutoFollow />)
    expect(document.querySelector('[data-scene-actions-region="1"]')).not.toBeInTheDocument()
    expect(document.querySelector('[data-scene-actions-region]')).not.toBeInTheDocument()
  })

  it('follows the playhead across a scene boundary into the next block', () => {
    const { rerender, props } = renderList({ currentTime: 0, isPlaying: false })
    // Begin playing inside scene 1 (0..6).
    rerender(<SceneBlockList {...props} currentTime={3} isPlaying />)
    expect(document.querySelector('[data-scene-actions-region="0"]')).toBeInTheDocument()
    // Cross into scene 2 (6..12) — auto-follow moves the expanded block.
    rerender(<SceneBlockList {...props} currentTime={9} isPlaying />)
    expect(document.querySelector('[data-scene-actions-region="1"]')).toBeInTheDocument()
    expect(document.querySelector('[data-scene-actions-region="0"]')).not.toBeInTheDocument()
  })
})
