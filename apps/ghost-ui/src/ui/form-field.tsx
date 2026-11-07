// App-owned UI. Retained-source notices: ./LICENSE.
import { useId, type ReactNode } from "react"
import { cn } from "./utils"

export interface FormFieldControlProps {
  id: string
  required?: boolean
  "aria-describedby"?: string
  "aria-invalid"?: true
  "aria-required"?: true
}

export interface FormFieldProps {
  id?: string
  label: string
  description?: string
  error?: string
  required?: boolean
  className?: string
  children: (controlProps: FormFieldControlProps) => ReactNode
}

/** Pass controlProps to the input so its label, help, and error remain connected. */
export function FormField({ id, label, description, error, required, children, className }: FormFieldProps) {
  const generated = useId()
  const controlId = id ?? generated
  const describedBy = [description && `${controlId}-help`, error && `${controlId}-error`].filter(Boolean).join(" ") || undefined
  return <div className={cn("ghost-form-field", className)}>
    <label htmlFor={controlId}>{label}{required && <span aria-hidden="true"> *</span>}</label>
    {children({ id: controlId, required: required || undefined, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, "aria-required": required ? true : undefined })}
    {description && <p id={`${controlId}-help`} className="ghost-form-field-help">{description}</p>}
    {error && <p id={`${controlId}-error`} className="ghost-form-field-error" role="alert">{error}</p>}
  </div>
}
