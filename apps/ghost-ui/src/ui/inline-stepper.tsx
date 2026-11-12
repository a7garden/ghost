// App-owned UI. Retained-source notices: ./LICENSE.
import type { KeyboardEvent } from "react"
import { Minus, Plus } from "lucide-react"

import { Input } from "./input"

export interface StepperBounds {
  min?: number
  max?: number
  step?: number
}

/**
 * Land on the step lattice anchored at min ?? 0, trimmed of float dust, and inside [min, max].
 * The contract validates submitted numbers against the same lattice (`matchesStep`), so the
 * stepper must never offer a value the wire would reject — clamping goes to the nearest on-lattice
 * point, not blindly to the bound.
 */
export function clampStepValue(raw: number, bounds: StepperBounds): string {
  const { min, max, step } = bounds
  const base = min ?? 0
  if (!Number.isFinite(raw)) return String(base)
  let next: number
  if (step !== undefined) {
    let units = Math.round((raw - base) / step)
    if (min !== undefined) units = Math.max(units, 0)
    if (max !== undefined) units = Math.min(units, Math.floor((max - base) / step + 1e-9))
    next = base + units * step
  } else {
    next = raw
    if (min !== undefined) next = Math.max(next, min)
    if (max !== undefined) next = Math.min(next, max)
  }
  // Step arithmetic leaves dust like 0.30000000000000004; twelve significant digits clears it.
  return String(Number(next.toPrecision(12)))
}

/** A number field as − value +: the common nudge one tap away, direct typing still allowed. */
export function InlineStepper({
  id,
  label,
  value,
  min,
  max,
  step,
  disabled,
  required,
  "aria-describedby": describedBy,
  onValueChange,
  onKeyDown,
}: {
  id?: string
  /** Accessible name for the value field when no external label points at it. */
  label: string
  value: string
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  required?: boolean
  "aria-describedby"?: string
  onValueChange(value: string): void
  onKeyDown?: (event: KeyboardEvent) => void
}) {
  const bounds = { min, max, step }
  const nudge = (direction: 1 | -1) => {
    // From empty, either button lands on the first allowed value instead of skipping past min.
    if (value === "" || !Number.isFinite(Number(value))) return onValueChange(clampStepValue(min ?? 0, bounds))
    onValueChange(clampStepValue(Number(value) + direction * (step ?? 1), bounds))
  }
  const button =
    "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-control text-ink transition-colors duration-150 outline-none hover:bg-hover focus-visible:shadow-[0_0_0_1.5px_var(--ghost-ink3)] disabled:pointer-events-none disabled:opacity-45"
  return (
    <div className="ghost-inline-stepper inline-flex items-center gap-1">
      <button type="button" aria-label="줄임" title="줄임" disabled={disabled} className={button} onClick={() => nudge(-1)}>
        <Minus className="size-4" aria-hidden="true" />
      </button>
      <Input
        id={id}
        required={required}
        aria-describedby={describedBy}
        disabled={disabled}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step ?? "any"}
        value={value}
        aria-label={id ? undefined : label}
        onKeyDown={onKeyDown}
        onChange={(event) => onValueChange(event.target.value)}
        className="w-20 text-center tabular [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button type="button" aria-label="늘림" title="늘림" disabled={disabled} className={button} onClick={() => nudge(1)}>
        <Plus className="size-4" aria-hidden="true" />
      </button>
    </div>
  )
}
