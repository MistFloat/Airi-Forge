import type { CharactersRemoteClient } from '../services/characters'
import type { InferenceServiceProvidersRemoteClient } from '../services/inference-service-providers'

import { hc } from 'hono/client'

import { authedFetch } from '../libs/auth-fetch'
import { SERVER_URL } from '../libs/server'

/**
 * Server API surface this renderer consumes.
 *
 * The typed Hono server app used to live in `apps/server` inside this
 * repository and the client was typed from its `AppType`. The server is
 * developed separately now, so the contract is declared where it is consumed
 * instead of imported. Keep the route groups in sync with the service
 * interfaces that describe them.
 */
export type StageApiClient
  = & Omit<CharactersRemoteClient, 'api'>
    & Omit<InferenceServiceProvidersRemoteClient, 'api'>
    & {
      api: {
        v1: CharactersRemoteClient['api']['v1']
          & InferenceServiceProvidersRemoteClient['api']['v1']
          & {
            /** Remaining credits of the signed-in account. */
            flux: {
              $get: () => Promise<Response>
            }
          }
      }
    }

// NOTICE:
// Without the server's app type, `hc` cannot infer the route tree and returns
// an index-signature client, so the runtime client (a real Hono proxy for
// `SERVER_URL`) is asserted against the contract declared above. Only the
// compile-time shape is restored; request behavior is unchanged.
// Removal condition: import the server app type again once the server ships
// from this repository or a published package.
export const client = hc(SERVER_URL, {
  fetch: authedFetch,
}) as unknown as StageApiClient
