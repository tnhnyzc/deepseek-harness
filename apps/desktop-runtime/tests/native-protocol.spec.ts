/**
 * The desktop native capability protocol: the closed message set, the strict
 * parsers, and the fail-closed refusals at the wire boundary. No DSH business
 * concept may be expressible in a message.
 */

import { describe, expect, it } from 'vitest'
import {
  NATIVE_ERROR_CODES,
  NATIVE_MAX_DIAGNOSTIC_CHARS,
  NATIVE_MAX_PATH_LENGTH,
  NATIVE_METHODS,
  NativeProtocolError,
  isNativeAbortMessage,
  isNativeCancelMessage,
  isNativeRequestMessage,
  isNativeResponseMessage,
  parseNativeAbort,
  parseNativeCancel,
  parseNativeRequest,
  parseNativeResponse,
} from '../src/native.ts'

describe('native protocol vocabulary', () => {
  it('closes the method set to the OS capability names', () => {
    expect(NATIVE_METHODS).toEqual(['directory.pick', 'path.open'])
  })

  it('closes the error-code set', () => {
    expect([...NATIVE_ERROR_CODES].sort()).toEqual(
      ['cancelled', 'dialog-failed', 'malformed-request', 'open-failed', 'unknown-method'],
    )
  })
})

describe('isNative*Message demux guards', () => {
  it('discriminates on the type tag only', () => {
    expect(isNativeRequestMessage({ type: 'native.request' })).toBe(true)
    expect(isNativeRequestMessage({ type: 'native.response' })).toBe(false)
    expect(isNativeRequestMessage(null)).toBe(false)
    expect(isNativeRequestMessage('native.request')).toBe(false)
    expect(isNativeResponseMessage({ type: 'native.response' })).toBe(true)
    expect(isNativeCancelMessage({ type: 'native.cancel' })).toBe(true)
    expect(isNativeCancelMessage({ type: 'native.request' })).toBe(false)
    expect(isNativeCancelMessage(undefined)).toBe(false)
    expect(isNativeAbortMessage({ type: 'native.abort' })).toBe(true)
    expect(isNativeAbortMessage({ type: 'native.cancel' })).toBe(false)
    expect(isNativeAbortMessage({ type: 'native.request' })).toBe(false)
    expect(isNativeAbortMessage(null)).toBe(false)
    expect(isNativeAbortMessage('native.abort')).toBe(false)
  })
})

describe('parseNativeRequest', () => {
  it('parses a directory.pick request without a payload', () => {
    expect(parseNativeRequest({ type: 'native.request', requestId: 'a', method: 'directory.pick' }))
      .toEqual({ type: 'native.request', requestId: 'a', method: 'directory.pick' })
  })

  it('parses a path.open request with its path', () => {
    expect(parseNativeRequest({ type: 'native.request', requestId: 'b', method: 'path.open', path: '/tmp/x' }))
      .toEqual({ type: 'native.request', requestId: 'b', method: 'path.open', path: '/tmp/x' })
  })

  it.each([
    ['a non-object', 'native.request'],
    ['the wrong type tag', { type: 'native.response', requestId: 'a', method: 'path.open' }],
    ['a missing request id', { type: 'native.request', method: 'path.open', path: '/tmp/x' }],
    ['an empty request id', { type: 'native.request', requestId: '', method: 'path.open', path: '/tmp/x' }],
    ['a non-string request id', { type: 'native.request', requestId: 1, method: 'path.open', path: '/tmp/x' }],
    ['an unknown method', { type: 'native.request', requestId: 'a', method: 'session.create' }],
    ['a missing path', { type: 'native.request', requestId: 'a', method: 'path.open' }],
    ['an empty path', { type: 'native.request', requestId: 'a', method: 'path.open', path: '' }],
    ['a NUL-bearing path', { type: 'native.request', requestId: 'a', method: 'path.open', path: '/tmp/a\0b' }],
    ['an oversized path', { type: 'native.request', requestId: 'a', method: 'path.open', path: 'x'.repeat(NATIVE_MAX_PATH_LENGTH + 1) }],
  ])('refuses %s', (_label, value) => {
    expect(() => parseNativeRequest(value)).toThrow(NativeProtocolError)
  })

  it('accepts a path at the exact bound', () => {
    const path = 'x'.repeat(NATIVE_MAX_PATH_LENGTH)
    expect(parseNativeRequest({ type: 'native.request', requestId: 'a', method: 'path.open', path }).path).toBe(path)
  })
})

describe('parseNativeResponse', () => {
  it('parses a directory.pick success carrying a path', () => {
    expect(parseNativeResponse({ type: 'native.response', requestId: 'a', ok: true, path: '/tmp/chosen' }))
      .toEqual({ type: 'native.response', requestId: 'a', ok: true, path: '/tmp/chosen' })
  })

  it('parses a directory.pick success carrying the operator cancel', () => {
    expect(parseNativeResponse({ type: 'native.response', requestId: 'a', ok: true, path: null }))
      .toEqual({ type: 'native.response', requestId: 'a', ok: true, path: null })
  })

  it('parses a path.open success without a value', () => {
    expect(parseNativeResponse({ type: 'native.response', requestId: 'b', ok: true }))
      .toEqual({ type: 'native.response', requestId: 'b', ok: true })
  })

  it('parses a closed-code failure', () => {
    expect(parseNativeResponse({ type: 'native.response', requestId: 'b', ok: false, code: 'open-failed', message: 'no' }))
      .toEqual({ type: 'native.response', requestId: 'b', ok: false, code: 'open-failed', message: 'no' })
  })

  it.each([
    ['a non-object', 42],
    ['the wrong type tag', { type: 'native.request', requestId: 'a', method: 'path.open', path: '/x' }],
    ['a missing request id', { type: 'native.response', ok: true }],
    ['a non-boolean ok', { type: 'native.response', requestId: 'a', ok: 'yes' }],
    ['an unknown code', { type: 'native.response', requestId: 'a', ok: false, code: 'session-lost', message: 'm' }],
    ['a missing failure message', { type: 'native.response', requestId: 'a', ok: false, code: 'open-failed' }],
    ['a non-string failure message', { type: 'native.response', requestId: 'a', ok: false, code: 'open-failed', message: 3 }],
    ['an over-bound failure message', { type: 'native.response', requestId: 'a', ok: false, code: 'open-failed', message: 'm'.repeat(NATIVE_MAX_DIAGNOSTIC_CHARS + 1) }],
    ['a non-string chooser path', { type: 'native.response', requestId: 'a', ok: true, path: 3 }],
  ])('refuses %s', (_label, value) => {
    expect(() => parseNativeResponse(value)).toThrow(NativeProtocolError)
  })

  it('accepts a failure message at the exact bound', () => {
    const message = 'm'.repeat(NATIVE_MAX_DIAGNOSTIC_CHARS)
    expect(parseNativeResponse({ type: 'native.response', requestId: 'a', ok: false, code: 'open-failed', message }).message).toBe(message)
  })
})

describe('parseNativeCancel', () => {
  it('parses a cancel with a reason', () => {
    expect(parseNativeCancel({ type: 'native.cancel', requestId: 'a', reason: 'generation ended' }))
      .toEqual({ type: 'native.cancel', requestId: 'a', reason: 'generation ended' })
  })

  it.each([
    ['a non-object', null],
    ['the wrong type tag', { type: 'native.response', requestId: 'a', ok: true }],
    ['a missing request id', { type: 'native.cancel', reason: 'r' }],
    ['an empty reason', { type: 'native.cancel', requestId: 'a', reason: '' }],
    ['a missing reason', { type: 'native.cancel', requestId: 'a' }],
    ['an over-bound reason', { type: 'native.cancel', requestId: 'a', reason: 'r'.repeat(NATIVE_MAX_DIAGNOSTIC_CHARS + 1) }],
  ])('refuses %s', (_label, value) => {
    expect(() => parseNativeCancel(value)).toThrow(NativeProtocolError)
  })

  it('accepts a reason at the exact bound', () => {
    const reason = 'r'.repeat(NATIVE_MAX_DIAGNOSTIC_CHARS)
    expect(parseNativeCancel({ type: 'native.cancel', requestId: 'a', reason }).reason).toBe(reason)
  })
})

describe('parseNativeAbort', () => {
  it('parses an abort with a reason', () => {
    expect(parseNativeAbort({ type: 'native.abort', requestId: 'a', reason: 'the caller aborted' }))
      .toEqual({ type: 'native.abort', requestId: 'a', reason: 'the caller aborted' })
  })

  it.each([
    ['a non-object', null],
    ['the wrong type tag', { type: 'native.cancel', requestId: 'a', reason: 'r' }],
    ['a missing request id', { type: 'native.abort', reason: 'r' }],
    ['an empty request id', { type: 'native.abort', requestId: '', reason: 'r' }],
    ['an empty reason', { type: 'native.abort', requestId: 'a', reason: '' }],
    ['a missing reason', { type: 'native.abort', requestId: 'a' }],
    ['an over-bound reason', { type: 'native.abort', requestId: 'a', reason: 'r'.repeat(NATIVE_MAX_DIAGNOSTIC_CHARS + 1) }],
  ])('refuses %s', (_label, value) => {
    expect(() => parseNativeAbort(value)).toThrow(NativeProtocolError)
  })

  it('accepts a reason at the exact bound', () => {
    const reason = 'r'.repeat(NATIVE_MAX_DIAGNOSTIC_CHARS)
    expect(parseNativeAbort({ type: 'native.abort', requestId: 'a', reason }).reason).toBe(reason)
  })
})
