/** The name a runtime's models are grouped under, above their list. */
export function RuntimeTitle({ label }: { label: string }) {
  return <h2 className="mb-2 truncate px-2 text-[12px] leading-[1.35] text-muted-foreground">{label}</h2>;
}
