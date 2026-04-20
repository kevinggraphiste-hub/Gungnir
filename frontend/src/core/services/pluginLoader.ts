/**
 * Gungnir — Frontend Plugin Loader
 *
 * Maps plugin names to their lazy-loaded React components.
 * Each plugin is code-split into a separate chunk.
 */
import React from 'react'

type LazyComponent = React.LazyExoticComponent<React.ComponentType<any>>

const PLUGIN_COMPONENTS: Record<string, () => Promise<{ default: React.ComponentType<any> }>> = {
  browser: () => import('../../plugins/browser/index'),
  voice: () => import('../../plugins/voice/index'),
  analytics: () => import('../../plugins/analytics/index'),
  code: () => import('../../plugins/code/index'),
  webhooks: () => import('../../plugins/webhooks/index'),
  channels: () => import('../../plugins/channels/index'),
  scheduler: () => import('../../plugins/scheduler/index'),
  model_guide: () => import('../../plugins/model_guide/index'),
  consciousness: () => import('../../plugins/consciousness/index'),
  valkyrie: () => import('../../plugins/valkyrie/index'),
}

const _cache: Record<string, LazyComponent> = {}

export function getPluginComponent(name: string): LazyComponent | null {
  if (_cache[name]) return _cache[name]

  const loader = PLUGIN_COMPONENTS[name]
  if (!loader) return null

  const component = React.lazy(loader)
  _cache[name] = component
  return component
}

export function isPluginRegistered(name: string): boolean {
  return name in PLUGIN_COMPONENTS
}
