"use client";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { getModel, runtimeName, type RuntimeId } from "@/lib/models";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { HistoryRequest } from "@/lib/history-api";
import { ipcMessage } from "@/lib/desktop";
import { ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageScroll } from "./page-scroll";
import { percent, useReopenHistory, useVaultProgress } from "./vault-gate";

const tokens = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}K` : String(value));
const seconds = (ms?: number) => (ms === undefined ? undefined : ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
/** A time as the lists show it: the time of day for today, else the date and time. */
export function when(time: number) {
  const date = new Date(time);
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function RequestRow({ record, onDelete }: { record: HistoryRequest; onDelete: () => void }) {
  const { threads, selectThread, setSettingsSection } = useStore();
  const [open, setOpen] = useState(false);
  const name = getModel(`local:${record.runtime as RuntimeId}:${record.model}`).name;
  const chat = threads.find((thread) => thread.id === record.sessionId);
  const outcome =
    record.status === "error"
      ? `Failed${record.reason ? ` · ${record.reason}` : ""}`
      : record.status === "cancelled"
        ? record.reason ?? "Stopped"
        : record.status === "running"
          ? "Running"
          : [`${tokens(record.tokens.input)} in`, `${tokens(record.tokens.output)} out`, record.tokens.reasoning ? `${tokens(record.tokens.reasoning)} thinking` : undefined, seconds(record.durationMs)]
              .filter(Boolean)
              .join(" · ");
  return (
    <div>
      <button aria-expanded={open} className="flex w-full items-center gap-3 p-3 text-left outline-none hover:bg-muted/30 focus-visible:bg-muted/30" onClick={() => setOpen((value) => !value)} type="button">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-[13px] leading-[1.4]">{name}</span>
            <span className="shrink-0 text-[12px] leading-[1.35] text-muted-foreground tabular-nums">{when(record.time)}</span>
          </div>
          <div className={cn("truncate text-[12px] leading-[1.35] tabular-nums", record.status === "error" ? "text-destructive" : "text-muted-foreground")}>{outcome}</div>
        </div>
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="space-y-3 px-3 pb-3">
          <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-[12px] leading-[1.35]">
            <dt className="text-muted-foreground">Chat</dt>
            <dd className="min-w-0 truncate">
              {chat ? (
                <button
                  className="truncate text-left underline-offset-2 outline-none hover:underline focus-visible:underline"
                  onClick={() => {
                    selectThread(chat.id);
                    setSettingsSection(null);
                  }}
                  type="button"
                >
                  {chat.title}
                </button>
              ) : (
                <span className="text-muted-foreground">{record.sessionTitle ?? "Not saved"}</span>
              )}
            </dd>
            <dt className="text-muted-foreground">Runtime</dt>
            <dd className="min-w-0 truncate">
              {runtimeName(record.runtime)} <span className="font-mono text-muted-foreground">{record.origin.replace(/^https?:\/\//, "")}</span>
            </dd>
            <dt className="text-muted-foreground">Model ID</dt>
            <dd className="min-w-0 truncate font-mono">{record.model}</dd>
          </dl>
          {record.content && (
            <pre className="max-h-64 overflow-auto rounded-[6px] bg-muted/40 p-3 font-mono text-[12px] leading-[1.35] whitespace-pre-wrap">
              {(() => {
                try {
                  const value = JSON.parse(record.content) as { messages?: { role?: string; content?: string }[] };
                  return (value.messages ?? []).map((message) => `${message.role}: ${message.content}`).join("\n\n");
                } catch {
                  return record.content;
                }
              })()}
            </pre>
          )}
          <button className="text-[12px] text-muted-foreground outline-none hover:text-destructive focus-visible:text-destructive" onClick={onDelete} type="button">
            Delete record
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The recovery key opens the encrypted history when the system keychain no longer can (electron/vault-key).
 * It is shown once when made; making a new one replaces it.
 */
function RecoveryKey() {
  const history = typeof window === "undefined" ? undefined : window.enduranceHistory;
  const [made, setMade] = useState<boolean>();
  const [shown, setShown] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    history?.vault().then((status) => setMade(status.hasRecovery)).catch(() => {});
  }, [history]);
  const make = async () => {
    try {
      setShown(await history!.newRecoveryKey());
      setMade(true);
    } catch (error) {
      toast(error instanceof Error ? ipcMessage(error) : "Couldn't make a recovery key");
    } finally {
      setConfirming(false);
    }
  };
  return (
    <section className="mt-3 rounded-[12px] border bg-card">
      <div className="flex items-center gap-6 p-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] leading-[1.4]">Recovery key</div>
          <div className="mt-1 text-[12px] leading-[1.35] text-muted-foreground">
            Restores access to your chats if the system keychain loses Endurance's key, such as after a keychain reset or a move to a new Mac. {made ? "A recovery key is set up." : "Not set up yet."}
          </div>
        </div>
        {!confirming && !shown && (
          <Button disabled={!history || made === undefined} onClick={() => (made ? setConfirming(true) : void make())} size="sm" variant="outline">
            {made ? "Make a new key" : "Create"}
          </Button>
        )}
      </div>
      {confirming && (
        <div className="flex items-center gap-2 px-3 pb-3">
          <span className="mr-auto text-[12px] leading-[1.35] text-muted-foreground">The current recovery key will stop working.</span>
          <Button onClick={() => setConfirming(false)} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button onClick={() => void make()} size="sm" variant="outline">
            Make a new key
          </Button>
        </div>
      )}
      {shown && (
        <div className="space-y-2 px-3 pb-3">
          <code className="block select-all break-all rounded-[6px] bg-muted/40 p-3 font-mono text-[12px] leading-[1.5]">{shown}</code>
          <div className="flex items-center gap-3 text-[12px] leading-[1.35]">
            <span className="mr-auto text-muted-foreground">Keep it in a password manager or on paper. Endurance shows it only now and keeps no copy.</span>
            <button
              className="text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
              onClick={() => navigator.clipboard.writeText(shown).then(() => toast("Copied"), () => toast("Couldn't copy"))}
              type="button"
            >
              Copy
            </button>
            <button className="text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground" onClick={() => setShown(undefined)} type="button">
              Done
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** A new data key for the history and attachments, for when the current one may have been exposed. */
function KeyRotation() {
  const history = typeof window === "undefined" ? undefined : window.enduranceHistory;
  const reopen = useReopenHistory();
  const progress = useVaultProgress();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const rotate = async () => {
    setBusy(true);
    try {
      await history!.rotateKey();
      toast("Encryption key changed", { description: "Your previous recovery key no longer works. Create a new one in History settings." });
      // Open chats still name attachments by their old names; start again from the stored history.
      reopen();
    } catch (error) {
      toast(error instanceof Error ? ipcMessage(error) : "Couldn't change the key");
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <section className="mt-3 rounded-[12px] border bg-card">
      <div className="flex items-center gap-6 p-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] leading-[1.4]">Encryption key</div>
          <div className="mt-1 text-[12px] leading-[1.35] text-muted-foreground">
            Chats, projects, and attachments are encrypted with a key stored in the system keychain. If you think it was exposed, change it to re-encrypt everything.
          </div>
        </div>
        {!confirming && (
          <Button disabled={!history} onClick={() => setConfirming(true)} size="sm" variant="outline">
            Change key
          </Button>
        )}
      </div>
      {confirming && (
        <div className="flex items-center gap-2 px-3 pb-3">
          <span className="mr-auto text-[12px] leading-[1.35] text-muted-foreground">The recovery key will stop working. Large histories take a moment.</span>
          <Button disabled={busy} onClick={() => setConfirming(false)} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void rotate()} size="sm" variant="outline">
            {busy ? (
              <>
                <LoaderCircleIcon className="animate-spin" />
                {progress?.stage === "rotating" && <span className="tabular-nums">{percent(progress)}</span>}
              </>
            ) : (
              "Change key"
            )}
          </Button>
        </div>
      )}
    </section>
  );
}

const NUDGED = "endurance:recovery-nudged";
/** Once the first chat is saved, suggests a recovery key one time; the person can ignore it. */
export function RecoveryNudge() {
  const { threads, setSettingsSection } = useStore();
  const saved = threads.some((thread) => !thread.temporary && thread.messages.length > 0);
  useEffect(() => {
    const history = window.enduranceHistory;
    if (!saved || !history) return;
    try {
      if (window.localStorage.getItem(NUDGED)) return;
    } catch {
      return;
    }
    let cancelled = false;
    history
      .vault()
      .then((status) => {
        if (cancelled || status.status !== "open" || status.hasRecovery) return;
        try {
          window.localStorage.setItem(NUDGED, "1");
        } catch {
          /* Shown again next time; harmless. */
        }
        toast("Save a recovery key", {
          description: "Use it to restore access to your chats if the system keychain loses Endurance's key.",
          action: { label: "Set up", onClick: () => setSettingsSection("history") },
          duration: 15_000,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [saved, setSettingsSection]);
  return null;
}

export function HistorySettings() {
  const history = typeof window === "undefined" ? undefined : window.enduranceHistory;
  const [records, setRecords] = useState<HistoryRequest[] | null>(history ? null : []);
  const [retain, setRetain] = useState(false);
  const load = useCallback(() => {
    window.enduranceHistory
      ?.requests()
      .then(setRecords)
      .catch(() => setRecords([]));
  }, []);
  useEffect(() => {
    load();
    window.enduranceHistory?.settings().then((value) => setRetain(value.retainRequests)).catch(() => {});
  }, [load]);
  const total = (records ?? []).reduce((sum, record) => sum + record.tokens.input + record.tokens.output + record.tokens.reasoning, 0);
  return (
    <PageScroll>
      <div className="mx-auto flex w-full max-w-xl flex-col">
        <h1 className="mb-6 pl-2 font-medium text-[15px] leading-[1.6]">History</h1>
        <section className="rounded-[12px] border bg-card">
          <div className="flex items-center gap-6 p-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] leading-[1.4]">Keep request contents</div>
              <div className="mt-1 text-[12px] leading-[1.35] text-muted-foreground">Store the messages sent with each request. Images are not stored.</div>
            </div>
            <Switch
              aria-label="Keep request contents"
              checked={retain}
              disabled={!history}
              onCheckedChange={async (value) => {
                try {
                  setRetain((await window.enduranceHistory!.setSettings({ retainRequests: value })).retainRequests);
                } catch {
                  toast("Couldn't change this setting");
                }
              }}
              size="sm"
            />
          </div>
        </section>
        <RecoveryKey />
        <KeyRotation />
        <div className="mt-7 mb-2 flex items-center justify-between px-2">
          <h2 className="text-[12px] leading-[1.35] text-muted-foreground">Requests</h2>
          <div className={cn("flex items-center gap-3 text-[12px] leading-[1.35] text-muted-foreground transition-opacity", records?.length ? "opacity-100" : "pointer-events-none opacity-0")}>
            <span className="tabular-nums">
              {records?.length ?? 0} {records?.length === 1 ? "request" : "requests"} · {tokens(total)} tokens
            </span>
            <button
              className="outline-none hover:text-foreground focus-visible:text-foreground"
              onClick={async () => {
                await window.enduranceHistory?.clearRequests();
                load();
              }}
              type="button"
            >
              Clear
            </button>
          </div>
        </div>
        <section aria-label="Requests" className="divide-y overflow-hidden rounded-[12px] border bg-card">
          {records === null && (
            <div className="p-3">
              <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" />
            </div>
          )}
          {records?.length === 0 && <p className="p-3 text-[12px] leading-[1.35] text-muted-foreground">No requests yet.</p>}
          {records?.map((record) => (
            <RequestRow
              key={record.id}
              onDelete={async () => {
                await window.enduranceHistory?.deleteRequest(record.id);
                load();
              }}
              record={record}
            />
          ))}
        </section>
        <p className="mt-2 px-2 text-[12px] leading-[1.35] text-muted-foreground">Requests to local models are kept for 30 days, up to 100. Deleting a chat deletes its requests.</p>
      </div>
    </PageScroll>
  );
}
