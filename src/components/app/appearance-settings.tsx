"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DEFAULT_APPEARANCE, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ChevronDownIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { PageScroll } from "./page-scroll";

const THEMES = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const DEFAULT_THEME = "dark";

function Stepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex h-7 items-center rounded-md border">
      <button
        aria-label="Decrease"
        className="flex size-7 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40"
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
        type="button"
      >
        <MinusIcon className="size-3.5" />
      </button>
      <span className="w-6 text-center text-[13px] tabular-nums">{value}</span>
      <button
        aria-label="Increase"
        className="flex size-7 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40"
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
        type="button"
      >
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      aria-checked={checked}
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full p-0.5",
        checked ? "bg-foreground/80" : "bg-foreground/15"
      )}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span className={cn("size-3 rounded-full bg-white shadow-sm", checked ? "translate-x-3" : "translate-x-0")} />
    </button>
  );
}

function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <input
      className="h-1 w-40 cursor-pointer appearance-none rounded-full bg-foreground/15 accent-foreground"
      max={max}
      min={min}
      onChange={(event) => onChange(Number(event.target.value))}
      step={step}
      type="range"
      value={value}
    />
  );
}

function ResetButton({ show, onClick }: { show: boolean; onClick: () => void }) {
  return (
    <button
      className={cn(
        "text-[12px] leading-[1.35] text-muted-foreground transition-opacity duration-150 hover:text-foreground",
        show ? "opacity-100" : "pointer-events-none opacity-0"
      )}
      inert={!show}
      onClick={onClick}
      type="button"
    >
      reset to default
    </button>
  );
}

function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-6 px-3 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-[13px] leading-[1.4]">{label}</div>
        <div className="text-[12px] leading-[1.35] text-muted-foreground">{hint}</div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">{children}</div>
    </div>
  );
}

function Section({
  title,
  dirty,
  onReset,
  children,
}: {
  title: string;
  dirty: boolean;
  onReset: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mt-7">
      <div className="mb-2 flex items-center justify-between px-2">
        <h2 className="text-[12px] leading-[1.35] text-muted-foreground">{title}</h2>
        <ResetButton onClick={onReset} show={dirty} />
      </div>
      <section className="divide-y overflow-hidden rounded-[12px] border bg-card">{children}</section>
    </div>
  );
}

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();
  const stored = useStore();
  const appearance = { ...DEFAULT_APPEARANCE, ...stored.appearance };
  const setAppearance = stored.setAppearance;
  const current = THEMES.find((item) => item.id === theme) ?? THEMES[1];
  const themeDirty = (theme ?? DEFAULT_THEME) !== DEFAULT_THEME;
  const typeDirty =
    appearance.uiFontSize !== DEFAULT_APPEARANCE.uiFontSize ||
    appearance.codeFontSize !== DEFAULT_APPEARANCE.codeFontSize;
  const agentDirty =
    appearance.toolCallDensity !== DEFAULT_APPEARANCE.toolCallDensity ||
    appearance.chatWidth !== DEFAULT_APPEARANCE.chatWidth ||
    appearance.codeWordWrap !== DEFAULT_APPEARANCE.codeWordWrap ||
    appearance.themedDiffBackgrounds !== DEFAULT_APPEARANCE.themedDiffBackgrounds;

  return (
    <PageScroll>
      <div className="mx-auto flex w-full max-w-xl flex-col">
        <h1 className="mb-6 pl-2 font-medium text-[15px] leading-[1.6]">Appearance</h1>
        <section className="overflow-hidden rounded-[12px] border bg-card">
          <Row hint="Light or dark" label="Theme">
            <div className="flex items-center gap-3">
              <ResetButton onClick={() => setTheme(DEFAULT_THEME)} show={themeDirty} />
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      className="flex h-7 items-center gap-1.5 rounded-md border px-2 text-[13px] outline-none hover:bg-muted/50 data-popup-open:bg-muted"
                      type="button"
                    />
                  }
                >
                  {current.label}
                  <ChevronDownIcon className="size-3.5 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-36 p-1" sideOffset={6}>
                  <DropdownMenuRadioGroup onValueChange={setTheme} value={current.id}>
                    {THEMES.map((item) => (
                      <DropdownMenuRadioItem
                        className="h-[26px] rounded-md py-0 text-[13px] font-normal"
                        key={item.id}
                        value={item.id}
                      >
                        {item.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </Row>
        </section>

        <Section
          dirty={typeDirty}
          onReset={() =>
            setAppearance({
              uiFontSize: DEFAULT_APPEARANCE.uiFontSize,
              codeFontSize: DEFAULT_APPEARANCE.codeFontSize,
            })
          }
          title="Typography"
        >
          <Row hint="Font size for the interface" label="UI Font Size">
            <Stepper
              max={18}
              min={11}
              onChange={(uiFontSize) => setAppearance({ uiFontSize })}
              value={appearance.uiFontSize}
            />
          </Row>
          <Row hint="Font size for code" label="Code Font Size">
            <Stepper
              max={18}
              min={11}
              onChange={(codeFontSize) => setAppearance({ codeFontSize })}
              value={appearance.codeFontSize}
            />
          </Row>
        </Section>

        <Section dirty={agentDirty} onReset={() => setAppearance({
          toolCallDensity: DEFAULT_APPEARANCE.toolCallDensity,
          chatWidth: DEFAULT_APPEARANCE.chatWidth,
          codeWordWrap: DEFAULT_APPEARANCE.codeWordWrap,
          themedDiffBackgrounds: DEFAULT_APPEARANCE.themedDiffBackgrounds,
        })} title="Agent Conversations">
          <Row hint="Adjust how much detail is shown for tool calls" label="Tool Call Density">
            <Slider
              max={100}
              min={0}
              onChange={(toolCallDensity) => setAppearance({ toolCallDensity })}
              value={appearance.toolCallDensity}
            />
            <div className="flex w-40 justify-between text-[11px] text-muted-foreground">
              <span>Compact</span>
              <span>Detailed</span>
            </div>
          </Row>
          <Row hint="Set the maximum width of conversations" label="Chat Width">
            <Slider
              max={1120}
              min={560}
              onChange={(chatWidth) => setAppearance({ chatWidth })}
              step={20}
              value={appearance.chatWidth}
            />
            <div className="flex w-40 justify-between text-[11px] text-muted-foreground">
              <span>Narrow</span>
              <span>{appearance.chatWidth}px</span>
              <span>Wide</span>
            </div>
          </Row>
          <Row hint="Wrap long lines in code blocks" label="Code Block Word Wrap">
            <Switch checked={appearance.codeWordWrap} onChange={(codeWordWrap) => setAppearance({ codeWordWrap })} />
          </Row>
          <Row hint="Use themed background colors for inline code diffs" label="Themed Diff Backgrounds">
            <Switch
              checked={appearance.themedDiffBackgrounds}
              onChange={(themedDiffBackgrounds) => setAppearance({ themedDiffBackgrounds })}
            />
          </Row>
        </Section>
      </div>
    </PageScroll>
  );
}
