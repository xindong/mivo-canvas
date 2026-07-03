import { describe, expect, it, vi } from 'vitest'

// chatStore imports canvasStore, which renders demo images via an HTML canvas at module
// load (`scenes()` → `createDemoImage` → `document.createElement('canvas')`). Stub the
// image generator so the node test environment stays hermetic.
vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))

import { clampChatGenerationContext, migrateChatPersistedState } from './chatStore'
import type { ChatGenerationContext, ChatMessage, ChatParamOverrides } from './chatStore'

// Helpers ---------------------------------------------------------------------

const context = (overrides: Partial<ChatGenerationContext> = {}): ChatGenerationContext => ({
  model: 'gemini-3-pro-image',
  requestedImgRatio: '16:9',
  requestedQuality: 'high',
  imgRatio: '16:9',
  quality: 'high',
  ...overrides,
})

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'msg-1',
  role: 'user',
  text: '画一只橘猫',
  createdAt: 1000,
  status: 'done',
  ...overrides,
})

const overrides = (patch: Partial<ChatParamOverrides> = {}): ChatParamOverrides => ({
  imgRatio: 'auto',
  quality: 'auto',
  ...patch,
})

// Tests -----------------------------------------------------------------------

describe('clampChatGenerationContext', () => {
  it('clamps an unsupported requestedImgRatio to auto for gemini (no 21:9)', () => {
    const result = clampChatGenerationContext(
      context({ model: 'gemini-3-pro-image', requestedImgRatio: '21:9', imgRatio: '21:9' }),
    )

    expect(result.requestedImgRatio).toBe('auto')
    expect(result.imgRatio).toBeUndefined()
  })

  it('preserves a supported ratio for gemini', () => {
    const result = clampChatGenerationContext(
      context({ model: 'gemini-3-pro-image', requestedImgRatio: '16:9', imgRatio: '16:9' }),
    )

    expect(result.requestedImgRatio).toBe('16:9')
    expect(result.imgRatio).toBe('16:9')
  })

  it('always preserves requestedImgRatio === auto regardless of model', () => {
    const result = clampChatGenerationContext(
      context({ model: 'gpt-image-2', requestedImgRatio: 'auto', imgRatio: undefined }),
    )

    expect(result.requestedImgRatio).toBe('auto')
    expect(result.imgRatio).toBeUndefined()
  })

  it('clamps a ratio valid for gemini but not for gpt-image-2 (4:3)', () => {
    const result = clampChatGenerationContext(
      context({ model: 'gpt-image-2', requestedImgRatio: '4:3', imgRatio: '4:3' }),
    )

    expect(result.requestedImgRatio).toBe('auto')
    expect(result.imgRatio).toBeUndefined()
  })

  it('falls back to gpt-image-2 capabilities for an unknown model', () => {
    // gpt-image-2 supports 16:9 but not 21:9
    const result = clampChatGenerationContext(
      context({ model: 'unknown-model', requestedImgRatio: '21:9', imgRatio: '21:9' }),
    )

    expect(result.requestedImgRatio).toBe('auto')
    expect(result.imgRatio).toBeUndefined()
  })

  it('leaves unrelated context fields untouched', () => {
    const result = clampChatGenerationContext(
      context({
        model: 'gemini-3-pro-image',
        requestedImgRatio: '21:9',
        sourceNodeId: 'node-1',
        finalPrompt: 'p',
        pendingSlotId: 'slot-1',
      }),
    )

    expect(result.sourceNodeId).toBe('node-1')
    expect(result.finalPrompt).toBe('p')
    expect(result.pendingSlotId).toBe('slot-1')
  })
})

describe('migrateChatPersistedState (chat persist v1→v2)', () => {
  it('passes v2 state through untouched (no ratio clamping on the v2 path)', () => {
    const v2State = {
      selectedModel: 'gemini-3-pro-image',
      paramOverrides: overrides({ imgRatio: '21:9' as never }), // invalid but v2 keeps it
      messagesByScene: {
        'scene-1': [
          message({
            generationContext: context({ requestedImgRatio: '21:9', imgRatio: '21:9' }),
          }),
        ],
      },
    }

    const result = migrateChatPersistedState(v2State, 2)

    expect(result.selectedModel).toBe('gemini-3-pro-image')
    expect(result.paramOverrides.imgRatio).toBe('21:9')
    expect(result.messagesByScene['scene-1'][0].generationContext?.requestedImgRatio).toBe('21:9')
  })

  it('converges an unsupported paramOverrides.imgRatio to auto at v1 (gemini)', () => {
    const result = migrateChatPersistedState(
      {
        selectedModel: 'gemini-3-pro-image',
        paramOverrides: overrides({ imgRatio: '21:9' as never }),
        messagesByScene: {},
      },
      1,
    )

    expect(result.paramOverrides.imgRatio).toBe('auto')
    expect(result.paramOverrides.quality).toBe('auto')
  })

  it('preserves a supported paramOverrides.imgRatio at v1', () => {
    const result = migrateChatPersistedState(
      {
        selectedModel: 'gemini-3-pro-image',
        paramOverrides: overrides({ imgRatio: '16:9', quality: 'high' }),
        messagesByScene: {},
      },
      1,
    )

    expect(result.paramOverrides.imgRatio).toBe('16:9')
    expect(result.paramOverrides.quality).toBe('high')
  })

  it('clamps generationContext ratios inside v1 messages via clampChatGenerationContext', () => {
    const result = migrateChatPersistedState(
      {
        selectedModel: 'gemini-3-pro-image',
        paramOverrides: overrides(),
        messagesByScene: {
          'scene-1': [
            message({
              generationContext: context({ requestedImgRatio: '21:9', imgRatio: '21:9' }),
            }),
            message({ generationContext: context({ requestedImgRatio: '16:9', imgRatio: '16:9' }) }),
            message({}), // no generationContext — left as-is
          ],
        },
      },
      1,
    )

    const messages = result.messagesByScene['scene-1']
    expect(messages[0].generationContext?.requestedImgRatio).toBe('auto')
    expect(messages[0].generationContext?.imgRatio).toBeUndefined()
    expect(messages[1].generationContext?.requestedImgRatio).toBe('16:9')
    expect(messages[1].generationContext?.imgRatio).toBe('16:9')
    expect(messages[2].generationContext).toBeUndefined()
  })

  it('defaults selectedModel to gemini-3-pro-image when missing at v1', () => {
    const result = migrateChatPersistedState(
      { paramOverrides: overrides(), messagesByScene: {} },
      1,
    )

    expect(result.selectedModel).toBe('gemini-3-pro-image')
  })

  it('defaults paramOverrides to auto/auto when missing at v1', () => {
    const result = migrateChatPersistedState(
      { selectedModel: 'gemini-3-pro-image', messagesByScene: {} },
      1,
    )

    expect(result.paramOverrides).toEqual({ imgRatio: 'auto', quality: 'auto' })
  })

  it('handles a null/undefined persisted state by returning defaults at v1', () => {
    const result = migrateChatPersistedState(null, 1)

    expect(result.selectedModel).toBe('gemini-3-pro-image')
    expect(result.paramOverrides).toEqual({ imgRatio: 'auto', quality: 'auto' })
    expect(result.messagesByScene).toEqual({})
  })

  it('converges against the persisted model, not a hardcoded one (gpt-image-2 has no 4:3)', () => {
    const result = migrateChatPersistedState(
      {
        selectedModel: 'gpt-image-2',
        paramOverrides: overrides({ imgRatio: '4:3' as never }),
        messagesByScene: {
          'scene-1': [
            message({
              generationContext: context({
                model: 'gpt-image-2',
                requestedImgRatio: '4:3',
                imgRatio: '4:3',
              }),
            }),
          ],
        },
      },
      1,
    )

    expect(result.paramOverrides.imgRatio).toBe('auto')
    expect(result.messagesByScene['scene-1'][0].generationContext?.requestedImgRatio).toBe('auto')
    expect(result.messagesByScene['scene-1'][0].generationContext?.imgRatio).toBeUndefined()
  })
})
