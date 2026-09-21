/**
 * The plugin's registrations, and their removal when the plugin goes.
 *
 * The Cordis context and the two slot declarations are real; the slot registry,
 * locale, and Remote faces are recorders, because what matters here is what was
 * handed to them — one foot action and one overlay body, sharing one store and
 * one inject face — and that every registration is gone after dispose, which is
 * what makes a reload safe.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { FooterButton } from '../src/client/FooterButton.tsx'
import { Workbench } from '../src/client/Workbench.tsx'
import { en, zh } from '../src/client/locales.ts'

interface Recorded {
  name: string
  id: string
  locale: string
  store: unknown
  inject: unknown
  component: unknown
}

async function boot() {
  const ctx = new Context()
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    register: vi.fn((ns: string, dicts: unknown) => {
      dictionaries.set(ns, dicts)
      return () => { dictionaries.delete(ns) }
    }),
  }
  const workspaceFiles = { list: vi.fn(), read: vi.fn() }
  const sessions = { create: vi.fn() }
  const workspaces = {
    list: { getSnapshot: (): { items: [] } => ({ items: [] }) },
    create: vi.fn(),
    attachSession: vi.fn(),
  }
  const uiWorkspace = { openSession: vi.fn() }
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('workspaces', workspaces as never)
  ctx.provide('uiWorkspace', uiWorkspace as never)
  ctx.provide('remote', { workspaceFiles } as never)
  ctx.provide('remote.workspaceFiles', workspaceFiles as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { registered, dictionaries, fiber }
}

describe('ui-llmpwa-pipeline apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('registers the dictionaries and both workbench surfaces with a shared store and face', async () => {
    const { registered, dictionaries } = await boot()
    expect(dictionaries.get('llmpwa')).toEqual({ zh, en })
    expect(registered.map(entry => [entry.name, entry.id, entry.locale, entry.component])).toEqual([
      ['sidebar.footer.action', 'llmpwa-workbench', 'llmpwa', FooterButton],
      ['shell.overlay', 'llmpwa-workbench', 'llmpwa', Workbench],
    ])
    expect(typeof registered[0]?.inject).toBe('function')
    expect(typeof registered[1]?.inject).toBe('function')
    // Both registrations share one store instance and one inject face.
    expect(registered[0]?.store).toBe(registered[1]?.store)
    expect(registered[0]?.inject).toBe(registered[1]?.inject)
  })

  it('takes every registration and dictionary back when the plugin is disposed', async () => {
    const { registered, dictionaries, fiber } = await boot()
    await fiber.dispose()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
})
