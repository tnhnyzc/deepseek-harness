/**
 * Connection carrier matrix. The plugin declares only `credentials` as a hard
 * dependency, so the Loader activates it on a host with or without a web
 * server. Web carrier: the /api prefix route mounts and browser session auth
 * is built. Desktop carrier (the seam this file guards): no webServer service
 * exists at all, yet the connection service still activates and serves the
 * in-process RPC interceptor dispatch the desktop transport's fetch channel
 * consumes. Reverting the dependency to `['webServer', 'credentials']` would
 * leave the desktop fiber pending forever, so the no-webServer boot is the
 * regression guard.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { WebRoute, WebServer, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH, apply, inject, type HostConnectionHandle } from '../src/index.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

/** Structural webServer fake recording the registered prefix routes. */
function fakeHttpServer(routes: WebRoute[]): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  const upgrades: WebUpgradeRoute[] = []
  return {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
}

describe('connection carrier matrix', () => {
  it('declares only credentials as a hard dependency', () => {
    expect(inject).toEqual(['credentials'])
  })

  it('activates without a webServer and serves the in-process RPC dispatch', async () => {
    const ctx = new Context()
    provideBrowserCredentials(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    expect(connection).toBeTypeOf('object')

    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const remove = connection.rpc.intercept('/api', endpoint => endpoint === 'session/list', async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: { items: [] } }
    })
    const handler = connection.createSharedFetchHandler('/api')
    const request = new Request('http://dsh.local/api/session/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'carrier-1',
        method: 'session/list',
        payload: { args: { _request: {} } },
      }),
    })
    const response = await handler.fetch(request)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      type: 'server-response',
      rpcId: 'carrier-1',
      result: { ok: true, value: { items: [] } },
    })
    expect(calls).toEqual([{ endpoint: 'session/list', payload: { args: { _request: {} } } }])
    await remove()
    await fiber.dispose()
  })

  it('mounts the /api prefix route only while a webServer is present', async () => {
    const routes: WebRoute[] = []
    const ctx = new Context()
    provideBrowserCredentials(ctx)
    ctx.provide('webServer', fakeHttpServer(routes))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(routes.map(route => route.path)).toEqual([API_PATH])
    await fiber.dispose()
    expect(routes).toHaveLength(0)
  })
})
