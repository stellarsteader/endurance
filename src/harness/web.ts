/**
 * Web search and page fetch. Portions derived from opencode (MIT; notice: vendor/LICENSE). Search calls Exa's hosted MCP endpoint, which needs no key; an EXA_API_KEY in the
 * environment is used when present. Fetch reads public pages only, so a model cannot reach local services.
 */
export interface WebResult {
  title: string;
  url: string;
  text: string;
}

const EXA_URL = process.env.EXA_API_KEY ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}` : "https://mcp.exa.ai/mcp";
const MAX_RESPONSE = 5 * 1024 * 1024;

function payload(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  const data = JSON.parse(trimmed) as { result?: { content?: { text?: string }[] }; error?: { message?: string } };
  if (data.error) throw new Error(`Web search failed: ${String(data.error.message ?? "unknown error").slice(0, 200)}`);
  return data.result?.content?.find((item) => item.text)?.text;
}

/** The hosted endpoint answers as JSON or as server-sent events. */
export function parseSearchResponse(body: string) {
  const direct = payload(body);
  if (direct) return direct;
  for (const line of body.split("\n")) if (line.startsWith("data: ")) {
    const value = payload(line.slice(6));
    if (value) return value;
  }
  return undefined;
}

/** Splits Exa's text answer into results: each starts with "Title:" and has a "URL:" line. */
export function parseResults(text: string): WebResult[] {
  const blocks = text.split(/\n(?=Title: )/);
  return blocks.flatMap((block) => {
    const title = /^Title: (.*)$/m.exec(block)?.[1]?.trim();
    const url = /^URL: (\S+)$/m.exec(block)?.[1]?.trim();
    if (!title || !url || !/^https?:\/\//.test(url)) return [];
    const body = block.replace(/^(Title|URL|Published|Author): .*$/gm, "").replace(/^Highlights:\s*$/m, "").trim();
    return [{ title: title.slice(0, 300), url, text: body }];
  });
}

export async function webSearch(query: string, signal: AbortSignal, transport: typeof fetch = fetch) {
  const text = String(query ?? "").trim().slice(0, 400);
  if (text.length < 2) throw new Error("Search for at least two characters.");
  const response = await transport(EXA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "web_search_exa", arguments: { query: text, type: "auto", numResults: 6, livecrawl: "fallback", contextMaxCharacters: 10_000 } },
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
  });
  if (!response.ok) throw new Error(`Web search failed (HTTP ${response.status}).`);
  const answer = parseSearchResponse(await response.text());
  return { query: text, results: answer ? parseResults(answer) : [], raw: answer ?? "" };
}

/** Hosts a page fetch may not reach: this computer, private networks and link-local metadata services. */
export function publicHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host === "::1" || host === "::" || /^(fc|fd|fe80)/.test(host) || host.startsWith("::ffff:")) return false;
  return true;
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function htmlToText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, code: string) =>
      code.startsWith("#") ? String.fromCodePoint(parseInt(code.slice(code[1].toLowerCase() === "x" ? 2 : 1), code[1].toLowerCase() === "x" ? 16 : 10)) : (entities[code.toLowerCase()] ?? match)
    )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

/** A public page as text, whole; the caller takes as much of it as its context has room for. */
export async function webFetch(input: string, signal: AbortSignal, transport: typeof fetch = fetch, redirects = 0): Promise<{ url: string; title: string; text: string }> {
  let url: URL;
  try {
    url = new URL(String(input ?? "").trim());
  } catch {
    throw new Error("Use a full http:// or https:// address.");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Use a public http:// or https:// address.");
  if (!publicHost(url.hostname)) throw new Error("Pages on this computer or a private network cannot be fetched.");
  const response = await transport(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      Accept: "text/markdown;q=1.0, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1",
    },
    redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  // Follow redirects only to public hosts.
  if (response.status >= 300 && response.status < 400) {
    const next = response.headers.get("location");
    if (!next || redirects >= 5) throw new Error("The page redirected too many times.");
    return webFetch(new URL(next, url).href, signal, transport, redirects + 1);
  }
  if (!response.ok) throw new Error(`The page returned HTTP ${response.status}.`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE) throw new Error("The page is larger than 5 MB.");
  const type = response.headers.get("content-type") ?? "";
  if (!/text|json|xml|markdown/.test(type)) throw new Error(`This address returns ${type || "binary data"}, not a page.`);
  const raw = new TextDecoder().decode(buffer);
  const text = /html/.test(type) ? htmlToText(raw) : raw;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim().slice(0, 200) ?? url.hostname;
  return { url: url.href, title: htmlToText(title), text };
}
