/**
 * Why a reply failed, carried from the chat worker to the chat as a tag in front of the message, so the chat
 * can say what happened and offer the action that fixes it. Pure, shared by both sides.
 */
export type FailureKind =
  /** The server did not answer: not running, wrong address, or the network. */
  | "unreachable"
  /** The runtime does not have the model, or the server now serves another name. */
  | "missing"
  /** The model could not be loaded in the memory available. */
  | "memory"
  /** The request did not fit the model's context window. */
  | "overflow"
  /** The runtime cannot take this model's tool calls. */
  | "tools"
  /** The model stopped sending output, or never started. */
  | "silent"
  /** The server is busy or rate-limiting. */
  | "busy"
  /** The server refused the key or headers. */
  | "auth"
  /** The model does not answer chat requests: an embedding or speech model. */
  | "notChat"
  | "other";

const KINDS: readonly FailureKind[] = ["unreachable", "missing", "memory", "overflow", "tools", "silent", "busy", "auth", "notChat", "other"];

export const tagFailure = (kind: FailureKind, message: string) => `[[${kind}]] ${message}`;

/** The kind and the readable message of a failure as the chat received it; untagged text is "other". */
export function readFailure(text: string): { kind: FailureKind; message: string } {
  const match = /^\[\[(\w+)\]\] ([\s\S]*)$/.exec(text);
  if (match && KINDS.includes(match[1] as FailureKind)) return { kind: match[1] as FailureKind, message: match[2] };
  return { kind: "other", message: text };
}
