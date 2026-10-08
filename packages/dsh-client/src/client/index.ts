/**
 * Jira workbench UI plugin, browser half. Four surface contributions over the
 * state owned by the external `@jira-workbench/dsh` host plugin:
 *
 * - a `plugins.bundle.config` page (the Jira URL + token) bound to the
 *   `jira-workbench` settings namespace the host registers, with the token
 *   written through the credentials domain (fixed `JIRA_WORKBENCH_TOKEN`
 *   reference), and
 * - a `shell.overlay` root workspace occupying DSH's main content area,
 * - a `sidebar.footer.action` entry toggling that workspace, and
 * - a `conversation.session.header.utilities` entry showing the Jira context
 *   linked to the current native DSH session.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the generated Remote namespaces (ctx.remote).
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the session-controller Context merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the settings shell's SlotMap merge and ctx.configForms.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls workspace-owned Session navigation and the root overlay slot.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the conversation header action SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the sidebar shell's SlotMap merge (sidebar.footer.action).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the external bundle's configuration SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { JiraConfigCard } from './JiraConfigCard.tsx'
import { JiraPanel } from './JiraPanel.tsx'
import { JiraSessionContext } from './JiraSessionContext.tsx'
import { JiraWorkspaceSurface } from './JiraWorkspaceSurface.tsx'
import { JIRA_WORKBENCH_NS, JiraConfigCardController, type JiraWorkbenchSettings } from './jira-config-card-controller.ts'
import { clearJiraSessionContext, loadJiraSessionContext } from './jira-session-context-api.ts'
import { en, NS, zh } from './locales.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms', 'sessions', 'uiWorkspace']

/**
 * Mount the config card, persistent workspace, board action, and session context.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-jira-workbench: dictionaries')

  const card = new JiraConfigCardController(
    ctx.configForms.get<JiraWorkbenchSettings>(JIRA_WORKBENCH_NS),
    ctx,
  )
  ctx.effect(() => () => { card.dispose() }, 'ui-jira-workbench: configuration subscription')
  const openSessionWhenVisible = async (sessionId: string): Promise<void> => {
    const id = sessionId as SessionId
    const visible = () => ctx.sessions.list.getSnapshot().byId[id] !== undefined
    if (visible()) {
      ctx.uiWorkspace.openSession(id)
      return
    }
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {}
      const timer = window.setTimeout(() => {
        unsubscribe()
        reject(new Error('DSH 会话已经创建，但会话列表尚未同步，请稍后从侧边栏打开。'))
      }, 5_000)
      unsubscribe = ctx.sessions.list.subscribe(() => {
        if (!visible()) return
        window.clearTimeout(timer)
        unsubscribe()
        try {
          ctx.uiWorkspace.openSession(id)
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: '@jira-workbench/dsh',
    locale: NS,
    inject: () => card.inject(),
  }, JiraConfigCard))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'jira-workbench-surface',
    order: 0,
    locale: NS,
    inject: () => ({
      ...card.inject(),
      openSession: openSessionWhenVisible,
    }),
  }, JiraWorkspaceSurface))

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'jira-workbench',
    locale: NS,
  }, JiraPanel))

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'jira-workbench-session-context',
    order: -10,
    locale: NS,
    inject: () => ({
      loadContext: loadJiraSessionContext,
      clearContext: clearJiraSessionContext,
    }),
  }, JiraSessionContext))
}
