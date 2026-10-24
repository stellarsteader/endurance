"use client";

import { useChatModels } from "@/features/model-settings/use-chat-models";

import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
} from "@/components/ai-elements/model-selector";
import { Kbd } from "@/components/ui/kbd";
import { arrangeModels, formatContext, type ModelCapability } from "@/lib/models";
import { useStore } from "@/lib/store";
import { runtimeContext } from "@/features/model-settings/preferences";
import { useSession } from "./session-context";
import { cn } from "@/lib/utils";
import { BrainIcon, CheckIcon, EyeIcon, WrenchIcon } from "lucide-react";
import { LocationBadge } from "./location-badge";

const capabilityIcon: Record<ModelCapability, typeof BrainIcon> = {
  reasoning: BrainIcon,
  vision: EyeIcon,
  tools: WrenchIcon,
};

export function ModelPicker() {
  const { modelPickerOpen, setModelPickerOpen, modelOrder } = useStore();
  const { model: current, choose } = useSession();
  // The order arranged by dragging in the composer's model menu; this list groups by provider within it.
  const models = arrangeModels(useChatModels(), modelOrder).flatMap((group) => group.models);
  const providers = [...new Set(models.map((model) => model.providerLabel))];

  return (
    <ModelSelector onOpenChange={setModelPickerOpen} open={modelPickerOpen}>
      <ModelSelectorContent className="sm:max-w-lg" title="Select a model">
        <ModelSelectorInput placeholder="Search models…" />
        <ModelSelectorList className="max-h-[420px]">
          <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
          {providers.map((provider) => (
            <ModelSelectorGroup heading={provider} key={provider}>
              {models.filter((m) => m.providerLabel === provider).map((m) => (
                <ModelSelectorItem
                  className="gap-3 py-2"
                  key={m.id}
                  onSelect={() => {
                    choose({ model: m.id });
                    setModelPickerOpen(false);
                  }}
                  value={`${m.name} ${m.providerLabel} ${m.id}`}
                >
                  <ModelSelectorLogo className="size-4" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} provider={m.provider} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ModelSelectorName className="font-medium">{m.name}</ModelSelectorName>
                      <LocationBadge location={m.location} />
                    </span>
                    <span className="truncate text-muted-foreground text-xs">{m.description}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    {m.capabilities.map((c) => {
                      const Icon = capabilityIcon[c];
                      return <Icon aria-label={c} className="size-3.5" key={c} />;
                    })}
                    <span className="w-9 text-right font-mono text-[11px]">{formatContext(m.runtime ? (runtimeContext(m).tokens ?? 0) : m.context)}</span>
                  </div>
                  <CheckIcon
                    className={cn("size-4", m.id === current.id ? "opacity-100" : "opacity-0")}
                  />
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
        <div className="flex items-center justify-between border-t px-3 py-2 text-muted-foreground text-xs">
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1"><BrainIcon className="size-3" />Reasoning</span>
            <span className="flex items-center gap-1"><EyeIcon className="size-3" />Vision</span>
            <span className="flex items-center gap-1"><WrenchIcon className="size-3" />Tools</span>
          </span>
          <span className="flex items-center gap-1">
            <Kbd>⌘</Kbd>
            <Kbd>/</Kbd>
          </span>
        </div>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
