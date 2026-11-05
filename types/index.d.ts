export type Router = { isOn: boolean; model: string }

declare module 'claude-code' {
  interface PluginState {
    provedores: {
      isRouterOn: boolean
      model: string
      models: string[]
      hasKey: boolean
      hasUrl: boolean
    }
  }
}
