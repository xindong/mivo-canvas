import type { Hono } from 'hono'

// Shared Hono environment for the BFF. Routes and middleware use this so a
// requestId flows from the top-level request-id middleware into every handler.
export type AppEnv = { Variables: { requestId: string } }
export type App = Hono<AppEnv>
