import { app, ipcMain } from "electron";
import { totalmem } from "node:os";
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";
import {
  deleteModel,
  modelDetails,
  mutateModel,
} from "../src/features/model-settings/runtime-service";
import {
  searchHuggingFace,
  downloadHuggingFace,
} from "../src/features/model-settings/huggingface";
import {
  lookupOllama,
  pullOllama,
} from "../src/features/model-settings/ollama-library";
import {
  DownloadRegistry,
  validDisplay,
} from "../src/features/model-settings/download-registry";
import { validConnectionId } from "../src/lib/connections";
import { managerDelete, managerDownload, managerDownloads, managerInfo, managerLogs, managerModels, managerPlan, managerStart, managerStop } from "../src/features/model-settings/manager-client";
import { hfToken } from "./hf-token";
import type { RuntimeId, ServerLocation } from "../src/lib/models";
import type {
  ConnectionTarget,
  HFDownloadRequest,
  HFProgress,
  OllamaHost,
  OllamaPullRequest,
  RuntimeTarget,
} from "../src/features/model-settings/types";

/** Hardware facts describe Ollama only when it runs on this computer. */
function ollamaHost(location: ServerLocation): OllamaHost {
  return {
    local: location === "this-computer",
    platform: process.platform,
    // An x64 build under Rosetta still runs on Apple silicon.
    appleSilicon:
      process.platform === "darwin" &&
      (process.arch === "arm64" || app.runningUnderARM64Translation),
    memory: totalmem(),
  };
}

interface Resolved extends RuntimeTarget {
  label: string;
  location: ServerLocation;
}

export function registerModelSettingsIPC(
  trusted: (event: IpcMainInvokeEvent | IpcMainEvent) => void,
  beforeMutation: () => void,
  resolve: (connectionId: string) => { runtime: RuntimeId; value: RuntimeTarget["connection"]; label: string; location: ServerLocation } | undefined,
) {
  // The renderer names a connection; its address and secrets come from the main process's saved copy.
  function boundTarget(target: ConnectionTarget): Resolved {
    const found = target && validConnectionId(target.connectionId) ? resolve(target.connectionId) : undefined;
    if (!found) throw new Error("This server is no longer listed. Refresh and retry.");
    return { runtime: found.runtime, connection: { ...found.value }, label: found.label, location: found.location };
  }
  const active = new Map<
    string,
    { controller: AbortController; owner: WebContents }
  >();
  function begin(id: string, owner: WebContents) {
    if (
      typeof id !== "string" ||
      !/^[a-z0-9-]{1,80}$/i.test(id) ||
      active.has(id)
    )
      throw new Error("Invalid request ID");
    const controller = new AbortController();
    active.set(id, { controller, owner });
    const cancel = () => controller.abort();
    owner.once("destroyed", cancel);
    return {
      signal: controller.signal,
      finish: () => {
        active.delete(id);
        if (!owner.isDestroyed()) owner.removeListener("destroyed", cancel);
      },
    };
  }
  ipcMain.handle(
    "models:details",
    (event, target: ConnectionTarget, modelId: string) => {
      trusted(event);
      const bound = boundTarget(target);
      return modelDetails(bound, modelId).then((details) => (bound.location === "this-computer" ? { ...details, hostMemory: totalmem() } : details));
    },
  );
  ipcMain.handle(
    "models:mutate",
    (
      event,
      target: ConnectionTarget,
      modelId: string,
      action: "context" | "delete",
      context?: number,
    ) => {
      trusted(event);
      // The renderer only changes a model's context or deletes it; the runtime loads models as requests need them.
      if (action !== "context" && action !== "delete") throw new Error("Invalid model operation");
      beforeMutation();
      if (action === "delete") return deleteModel(boundTarget(target), modelId);
      if (typeof context !== "number") throw new Error("Choose a context window");
      return mutateModel(boundTarget(target), modelId, action, context);
    },
  );
  ipcMain.handle(
    "models:hf-search",
    async (event, id: string, query: string) => {
      trusted(event);
      const task = begin(id, event.sender);
      try {
        return await searchHuggingFace(query, task.signal);
      } finally {
        task.finish();
      }
    },
  );
  const downloads = new DownloadRegistry<WebContents>((owner, list) => {
    if (!owner.isDestroyed()) owner.send("models:downloads", list);
  });
  const watched = new WeakSet<WebContents>();
  // The download runs on after the handler returns; its state reaches the window as snapshots.
  function startDownload(
    event: IpcMainInvokeEvent,
    id: string,
    target: Resolved & { connectionId: string },
    display: unknown,
    run: (
      progress: (value: HFProgress) => void,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {
    const details = validDisplay(display);
    const owner = event.sender;
    const task = begin(id, owner);
    if (!watched.has(owner)) {
      watched.add(owner);
      owner.once("destroyed", () => downloads.forget(owner));
    }
    try {
      void downloads
        .start(owner, id, { runtime: target.runtime, connectionId: target.connectionId, connectionLabel: target.label }, details, (progress) => run(progress, task.signal), task.signal)
        .finally(task.finish);
    } catch (error) {
      task.finish();
      throw error;
    }
  }
  ipcMain.handle(
    "models:hf-download",
    (event, id: string, input: HFDownloadRequest, display: unknown) => {
      trusted(event);
      const target = { ...boundTarget(input), connectionId: input.connectionId };
      const request = { repository: input?.repository, filename: input?.filename, runtime: target.runtime, connection: target.connection };
      startDownload(event, id, target, display, (progress, signal) =>
        downloadHuggingFace(request, progress, signal),
      );
    },
  );
  ipcMain.handle(
    "models:ollama-lookup",
    async (event, id: string, query: string, target?: ConnectionTarget) => {
      trusted(event);
      const found = target ? boundTarget(target) : undefined;
      const bound = found?.runtime === "ollama" ? found : undefined;
      const task = begin(id, event.sender);
      try {
        return await lookupOllama(
          query,
          task.signal,
          bound ? { target: bound, host: ollamaHost(bound.location) } : {},
        );
      } finally {
        task.finish();
      }
    },
  );
  ipcMain.handle(
    "models:ollama-pull",
    (event, id: string, input: OllamaPullRequest, display: unknown) => {
      trusted(event);
      const target = { ...boundTarget(input), connectionId: input.connectionId };
      startDownload(event, id, target, display, (progress, signal) =>
        pullOllama({ model: input?.model, runtime: target.runtime, connection: target.connection }, progress, signal),
      );
    },
  );
  ipcMain.handle("models:downloads", (event) => {
    trusted(event);
    return downloads.list(event.sender);
  });
  ipcMain.on("models:download-dismiss", (event, id: string) => {
    trusted(event);
    if (typeof id === "string") downloads.dismiss(event.sender, id);
  });
  ipcMain.on("models:cancel", (event, id: string) => {
    trusted(event);
    const task = active.get(id);
    if (task?.owner === event.sender) task.controller.abort();
  });
  // The vLLM manager on a server the person runs (server/). Starting, stopping and deleting wait for replies to end.
  const managed = (target: ConnectionTarget) => {
    const bound = boundTarget(target);
    if (bound.runtime !== "vllm") throw new Error("Only a vLLM connection can be a managed server.");
    return bound.connection;
  };
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  ipcMain.handle("manager:info", (event, target: ConnectionTarget) => {
    trusted(event);
    return managerInfo(managed(target));
  });
  ipcMain.handle("manager:models", (event, target: ConnectionTarget) => {
    trusted(event);
    return managerModels(managed(target));
  });
  ipcMain.handle("manager:plan", (event, target: ConnectionTarget, model: unknown, window: unknown) => {
    trusted(event);
    return managerPlan(managed(target), text(model), typeof window === "number" ? window : undefined);
  });
  ipcMain.handle("manager:start", (event, target: ConnectionTarget, model: unknown, options: { window?: unknown; image?: unknown }) => {
    trusted(event);
    beforeMutation();
    const window = typeof options?.window === "number" && Number.isSafeInteger(options.window) ? options.window : undefined;
    const image = typeof options?.image === "string" && options.image.trim() ? options.image.trim() : undefined;
    return managerStart(managed(target), text(model), { ...(window ? { window } : {}), ...(image ? { image } : {}) });
  });
  ipcMain.handle("manager:stop", (event, target: ConnectionTarget, model: unknown) => {
    trusted(event);
    beforeMutation();
    return managerStop(managed(target), text(model));
  });
  ipcMain.handle("manager:delete", (event, target: ConnectionTarget, model: unknown) => {
    trusted(event);
    beforeMutation();
    return managerDelete(managed(target), text(model));
  });
  ipcMain.handle("manager:logs", (event, target: ConnectionTarget, model: unknown) => {
    trusted(event);
    return managerLogs(managed(target), text(model));
  });
  ipcMain.handle("manager:download", (event, target: ConnectionTarget, model: unknown) => {
    trusted(event);
    return managerDownload(managed(target), text(model), hfToken());
  });
  ipcMain.handle("manager:downloads", (event, target: ConnectionTarget) => {
    trusted(event);
    return managerDownloads(managed(target));
  });
}
