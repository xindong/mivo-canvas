import type { HttpBindings } from '@hono/node-server'
import type { Hono } from 'hono'

// Shared Hono environment for the BFF. Routes and middleware use this so a
// requestId can flow from the top-level middleware, while node HttpBindings stay
// available to routes that need socket-close awareness for upstream aborts.
export type AppEnv = {
  Bindings: HttpBindings
  Variables: { requestId: string }
}
export type App = Hono<AppEnv>
