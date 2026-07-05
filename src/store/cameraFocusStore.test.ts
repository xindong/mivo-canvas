import { beforeEach, describe, expect, it } from 'vitest'
import { useCameraFocusStore } from './cameraFocusStore'

beforeEach(() => {
  useCameraFocusStore.setState({ pendingFocus: undefined })
})

describe('cameraFocusStore', () => {
  it('records a pending focus request for the active scene', () => {
    useCameraFocusStore.getState().requestPlaceholderFocus('slot-1', {
      targetSceneId: 'c1',
      activeSceneId: 'c1',
      source: 'chat-slot',
    })
    expect(useCameraFocusStore.getState().pendingFocus).toEqual({ nodeId: 'slot-1', source: 'chat-slot' })
  })

  it('records an explicit center focus request for the active scene', () => {
    useCameraFocusStore.getState().requestNodeFocus('node-1', {
      targetSceneId: 'c1',
      activeSceneId: 'c1',
      source: 'chat-result',
      mode: 'center',
    })
    expect(useCameraFocusStore.getState().pendingFocus).toEqual({ nodeId: 'node-1', source: 'chat-result', mode: 'center' })
  })

  it('skips cross-scene requests (keeps #95 semantics: no scene switch, no camera move)', () => {
    useCameraFocusStore.getState().requestPlaceholderFocus('slot-1', {
      targetSceneId: 'c2',
      activeSceneId: 'c1',
      source: 'mask-edit',
    })
    expect(useCameraFocusStore.getState().pendingFocus).toBeUndefined()
  })

  it('skips explicit node focus requests across scenes', () => {
    useCameraFocusStore.getState().requestNodeFocus('node-1', {
      targetSceneId: 'c2',
      activeSceneId: 'c1',
      source: 'chat-result',
      mode: 'center',
    })
    expect(useCameraFocusStore.getState().pendingFocus).toBeUndefined()
  })

  it('re-requesting the same node produces a fresh request object (retry re-triggers the effect)', () => {
    const request = () =>
      useCameraFocusStore.getState().requestPlaceholderFocus('slot-1', {
        targetSceneId: 'c1',
        activeSceneId: 'c1',
        source: 'chat-slot',
      })
    request()
    const first = useCameraFocusStore.getState().pendingFocus
    request()
    const second = useCameraFocusStore.getState().pendingFocus
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
  })

  it('clearPlaceholderFocus resets the pending request', () => {
    useCameraFocusStore.getState().requestPlaceholderFocus('slot-1', {
      targetSceneId: 'c1',
      activeSceneId: 'c1',
      source: 'chat-slot',
    })
    useCameraFocusStore.getState().clearPlaceholderFocus()
    expect(useCameraFocusStore.getState().pendingFocus).toBeUndefined()
  })
})
