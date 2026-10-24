import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Input } from "../../components/ui/input";
import { cn } from "../../lib/utils";
import { SAMPLING_FIELDS, SAMPLING_SPECS, samplingValue, type SamplingField, type SamplingSets } from "../../lib/sampling";
import type { RuntimeModelDetails } from "./types";

/** What the person typed, per set and field; empty is the model's own value. */
export type SamplingDraft = Record<keyof SamplingSets, Partial<Record<SamplingField, string>>>;

export const draftOf = (sets: SamplingSets | undefined): SamplingDraft => ({
  thinking: Object.fromEntries(Object.entries(sets?.thinking ?? {}).map(([field, value]) => [field, String(value)])),
  plain: Object.fromEntries(Object.entries(sets?.plain ?? {}).map(([field, value]) => [field, String(value)])),
});

/** The fields typed in a way that is not a value in range, by set. */
export const invalidFields = (draft: SamplingDraft) =>
  (Object.keys(draft) as (keyof SamplingSets)[]).flatMap((set) =>
    SAMPLING_FIELDS.filter((field) => draft[set][field]?.trim() && samplingValue(field, draft[set][field]) === undefined).map((field) => ({ set, field }))
  );

/** The draft as saved: only the values set. A model that does not think keeps only its one set. */
export function setsOf(draft: SamplingDraft, thinks: boolean): SamplingSets | undefined {
  const pick = (values: SamplingDraft[keyof SamplingSets]) => {
    const set = Object.fromEntries(SAMPLING_FIELDS.flatMap((field) => (samplingValue(field, values[field]) === undefined ? [] : [[field, samplingValue(field, values[field])]])));
    return Object.keys(set).length ? set : undefined;
  };
  const thinking = thinks ? pick(draft.thinking) : undefined;
  const plain = pick(draft.plain);
  return thinking || plain ? { ...(thinking ? { thinking } : {}), ...(plain ? { plain } : {}) } : undefined;
}

/** Sampling for one model: empty fields show what the model will use. */
export function SamplingFields({
  draft,
  onChange,
  details,
  thinks,
  disabled,
}: {
  draft: SamplingDraft;
  onChange: (draft: SamplingDraft) => void;
  details: RuntimeModelDetails | null;
  thinks: boolean;
  disabled?: boolean;
}) {
  const [set, setSet] = useState<keyof SamplingSets>(thinks ? "thinking" : "plain");
  // Sampling sits under Advanced, open from the start when something is already set.
  const [advanced, setAdvanced] = useState(() => SAMPLING_FIELDS.some((field) => draft.thinking[field] || draft.plain[field]));
  const shown = thinks ? set : "plain";
  const known = details?.sampling;
  const hint = "Controls how random the answers are.";
  // An empty field shows the value used in its place, as placeholder text: grey text in a field reads as the
  // default without saying so. Where the runtime does not tell the value, the field just says Default.
  const placeholder = (field: SamplingField) => {
    const value = known?.values[field];
    return value === undefined ? "Default" : String(value);
  };
  const changed = SAMPLING_FIELDS.some((field) => draft[shown][field]?.trim());
  const field = (name: SamplingField) => {
    const spec = SAMPLING_SPECS[name];
    const text = draft[shown][name] ?? "";
    const bad = Boolean(text.trim()) && samplingValue(name, text) === undefined;
    return (
      <label className="flex items-center justify-between gap-3" key={name}>
        <span className="text-[12px] text-muted-foreground">{spec.label}</span>
        <Input
          aria-invalid={bad || undefined}
          aria-label={`${spec.label}${thinks ? (shown === "thinking" ? " with thinking on" : " with thinking off") : ""}`}
          className={cn("h-7 w-32 rounded-[6px] text-right text-[13px] tabular-nums", bad && "border-destructive")}
          disabled={disabled}
          inputMode="decimal"
          onChange={(event) => onChange({ ...draft, [shown]: { ...draft[shown], [name]: event.target.value } })}
          placeholder={placeholder(name)}
          title={`${spec.min} to ${spec.max}${spec.integer ? ", whole numbers" : ""}`}
          value={text}
        />
      </label>
    );
  };
  return (
    <div className="space-y-2.5">
      <button
        aria-expanded={advanced}
        className="flex items-center gap-1 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
        disabled={disabled}
        onClick={() => setAdvanced((value) => !value)}
        type="button"
      >
        <ChevronRightIcon className={cn("size-3", advanced && "rotate-90")} />
        Advanced
      </button>
      {advanced && (
        <>
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] leading-[1.4]">Sampling</div>
              <div className="mt-1 text-[12px] leading-[1.35] text-muted-foreground">{hint}</div>
            </div>
            {thinks && (
              <div className="flex shrink-0 rounded-[7px] bg-muted p-0.5 text-[12px]" role="group" aria-label="Sampling set">
                {(["thinking", "plain"] as const).map((item) => (
                  <button
                    aria-pressed={set === item}
                    className={cn("rounded-[5px] px-2 py-0.5 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring", set === item && "bg-background text-foreground shadow-xs")}
                    disabled={disabled}
                    key={item}
                    onClick={() => setSet(item)}
                    type="button"
                  >
                    {item === "thinking" ? "Thinking on" : "Thinking off"}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">{SAMPLING_FIELDS.map(field)}</div>
          {changed && (
            <div className="flex justify-end text-[12px]">
              <button className="text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground" disabled={disabled} onClick={() => onChange({ ...draft, [shown]: {} })} type="button">
                Use the model’s values
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
