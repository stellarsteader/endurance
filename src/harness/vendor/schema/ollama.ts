export * as Ollama from "./ollama"

export function baseURL(value: string) {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("configuration")
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")
  return url.toString().replace(/\/+$/, "")
}

export function validTag(tag: string) {
  return typeof tag === "string" && tag.length > 0 && tag.length <= 240 && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(tag)
}

export function tagKey(tag: string) {
  return tag.slice(tag.lastIndexOf("/") + 1).includes(":") ? tag : `${tag}:latest`
}

export function isRunnerTag(tag: string) {
  // Ollama's GGUF migration stores a runner manifest under this internal tag.
  // The original model references it; it is not a separate user model to manage or delete.
  return /^llamacpp:[a-f0-9]{64}$/.test(tag)
}

export function userModels<T extends { name: string }>(models: T[]) {
  const seen = new Set<string>()
  return models.filter((model) => {
    if (isRunnerTag(model.name)) return false
    // Multi-runner manifests can appear more than once under the same public tag.
    const key = tagKey(model.name)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
