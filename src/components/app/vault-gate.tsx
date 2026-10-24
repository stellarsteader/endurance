"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { VaultProgress, VaultStatus } from "@/lib/history-api";
import { ipcMessage } from "@/lib/desktop";
import { createContext, Fragment, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

const COPY: Record<Extract<VaultStatus, { status: "locked" }>["reason"], { title: string; body: string }> = {
  unreadable: {
    title: "Your history is locked",
    body: "Endurance couldn't get the key that opens your chats from the system keychain. If you denied a keychain prompt, try again and allow it.",
  },
  keystore: {
    title: "No keychain to protect your history",
    body: "Endurance keeps chats encrypted with a key held by the system keychain, and none is available. On Linux, install and unlock a keyring such as GNOME Keyring or KWallet, then try again.",
  },
  missing: {
    title: "Your history can't be opened",
    body: "The key that opens your saved chats is missing or belongs to another history. Without it they can't be read.",
  },
};

const Reopen = createContext<() => void>(() => {});
/** Starts the app again from the stored history, as after a key rotation renamed the attachments it holds. */
export const useReopenHistory = () => useContext(Reopen);

/**
 * The app opens once the encrypted history does (electron/vault-key). While it is locked this screen stands in
 * for it: try the keychain again, enter the recovery key, or start over. Nothing is deleted unless the person
 * chooses to start over.
 */
export function VaultGate({ children }: { children: ReactNode }) {
  const history = typeof window === "undefined" ? undefined : window.enduranceHistory;
  const [status, setStatus] = useState<VaultStatus | null>(history ? null : { status: "open", hasRecovery: false });
  const [opened, setOpened] = useState(0);
  const progress = useVaultProgress();
  const reopen = useCallback(() => setOpened((count) => count + 1), []);
  useEffect(() => {
    history?.vault().then(setStatus, () => setStatus({ status: "open", hasRecovery: false }));
  }, [history]);
  // The first start after an update encrypts the history kept before; it can take a while for a large one.
  if (!status) return progress ? <Encrypting progress={progress} /> : null;
  if (status.status === "open")
    return (
      <Reopen.Provider value={reopen}>
        <Fragment key={opened}>{children}</Fragment>
      </Reopen.Provider>
    );
  return <LockedHistory onOpen={setStatus} status={status} />;
}

/** The latest progress of encrypting the history, while it runs. */
export function useVaultProgress() {
  const [progress, setProgress] = useState<VaultProgress>();
  useEffect(() => window.enduranceHistory?.onVaultProgress(setProgress), []);
  return progress;
}

/** "n%" of the step under way. */
export const percent = (progress: VaultProgress) => `${Math.floor((100 * progress.done) / Math.max(1, progress.total))}%`;

function Encrypting({ progress }: { progress: VaultProgress }) {
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="desktop-drag h-10 shrink-0" />
      <main className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md pl-2">
          <h1 className="font-medium text-[15px] leading-[1.6]">Encrypting your history</h1>
          <p className="mt-1 text-[13px] leading-[1.5] text-muted-foreground">
            Chats and attachments saved before this version are being encrypted. This happens once. <span className="tabular-nums">{percent(progress)}</span>
          </p>
        </div>
      </main>
    </div>
  );
}

function LockedHistory({ status, onOpen }: { status: Extract<VaultStatus, { status: "locked" }>; onOpen: (status: VaultStatus) => void }) {
  const history = window.enduranceHistory!;
  const [key, setKey] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const copy = COPY[status.reason];
  // The app has not started while locked, so once the history opens it simply starts.
  const act = async (work: () => Promise<VaultStatus>, failed: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await work();
      if (next.status === "open") onOpen(next);
      else setError(failed);
    } catch (reason) {
      setError(reason instanceof Error ? ipcMessage(reason) : failed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="desktop-drag h-10 shrink-0" />
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
        <div className="w-full max-w-md">
          <h1 className="pl-2 font-medium text-[15px] leading-[1.6]">{copy.title}</h1>
          <p className="mt-1 mb-5 pl-2 text-[13px] leading-[1.5] text-muted-foreground">{copy.body}</p>
          <section className="divide-y rounded-[12px] border bg-card">
            {status.reason !== "missing" && (
              <div className="flex items-center gap-6 p-3">
                <div className="min-w-0 flex-1 text-[13px] leading-[1.4]">Ask the keychain again</div>
                <Button disabled={busy} onClick={() => act(() => history.retryVault(), "The keychain still didn't open your history.")} size="sm" variant="outline">
                  Try again
                </Button>
              </div>
            )}
            {status.hasRecovery && (
              <form
                className="space-y-2 p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (key.trim()) void act(() => history.recoverVault(key), "This recovery key doesn't open your history.");
                }}
              >
                <label className="block text-[13px] leading-[1.4]" htmlFor="recovery-key">
                  Recovery key
                </label>
                <div className="flex gap-2">
                  <Input autoComplete="off" className="font-mono text-[12px]" id="recovery-key" onChange={(event) => setKey(event.target.value)} placeholder="XXXX-XXXX-XXXX-…" spellCheck={false} value={key} />
                  <Button disabled={busy || !key.trim()} size="sm" type="submit" variant="outline">
                    Open
                  </Button>
                </div>
              </form>
            )}
            {status.reason !== "keystore" && (
              <div className="space-y-2 p-3">
                <div className="flex items-center gap-6">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] leading-[1.4]">Start over</div>
                    <div className="mt-1 text-[12px] leading-[1.35] text-muted-foreground">Deletes the saved chats, projects and attachments that can't be opened.</div>
                  </div>
                  {!confirming && (
                    <Button disabled={busy} onClick={() => setConfirming(true)} size="sm" variant="outline">
                      Start over
                    </Button>
                  )}
                </div>
                {confirming && (
                  <div className="flex justify-end gap-2">
                    <Button disabled={busy} onClick={() => setConfirming(false)} size="sm" variant="ghost">
                      Cancel
                    </Button>
                    <Button disabled={busy} onClick={() => act(() => history.startOver(), "Endurance couldn't start a new history.")} size="sm" variant="destructive">
                      Delete history
                    </Button>
                  </div>
                )}
              </div>
            )}
          </section>
          {error && <p className="mt-2 px-2 text-[12px] leading-[1.35] text-destructive">{error}</p>}
        </div>
      </main>
    </div>
  );
}
