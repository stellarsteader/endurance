export * as TransportPolicy from "./network-policy"

import { Context, Effect } from "effect"
import { LLMError, TransportReason } from "../schema"

// Hosts inject policy. The reusable LLM package knows no project or server configuration.
export class Service extends Context.Service<Service, { readonly assert: (url: string) => Promise<unknown> }>()(
  "@opencode/LLM/TransportPolicy",
) {}

export const check = (url: string) =>
  Effect.gen(function* () {
    const policy = yield* Effect.serviceOption(Service)
    if (policy._tag === "None") return
    yield* Effect.tryPromise({
      try: () => policy.value.assert(url),
      catch: () =>
        new LLMError({
          module: "TransportPolicy",
          method: "check",
          reason: new TransportReason({
            message: "Server network policy blocks this model destination",
            kind: "Policy",
          }),
        }),
    })
  })
