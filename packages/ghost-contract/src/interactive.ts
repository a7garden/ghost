import { Type, type Static } from 'typebox';
import { Check, Errors } from 'typebox/value';
import { ContractError } from './validate.ts';

const Id = Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' });
const Title = Type.String({ minLength: 1, maxLength: 160 });
const Label = Type.String({ minLength: 1, maxLength: 120 });
const Option = Type.Object({ value: Type.String({ minLength: 1, maxLength: 120 }), label: Label }, { additionalProperties: false });
const FieldBase = { id: Id, label: Label, required: Type.Optional(Type.Boolean()) };

export const UiField = Type.Union([
  Type.Object({ ...FieldBase, type: Type.Literal('text'), multiline: Type.Optional(Type.Boolean()), placeholder: Type.Optional(Type.String({ maxLength: 200 })), value: Type.Optional(Type.String({ maxLength: 2000 })) }, { additionalProperties: false }),
  Type.Object({ ...FieldBase, type: Type.Literal('number'), min: Type.Optional(Type.Number()), max: Type.Optional(Type.Number()), step: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), value: Type.Optional(Type.Number()) }, { additionalProperties: false }),
  Type.Object({ ...FieldBase, type: Type.Literal('select'), options: Type.Array(Option, { minItems: 1, maxItems: 20 }), value: Type.Optional(Type.String({ maxLength: 120 })) }, { additionalProperties: false }),
  Type.Object({ ...FieldBase, type: Type.Literal('checkbox'), value: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
]);
export type UiField = Static<typeof UiField>;

export const UiForm = Type.Object({
  type: Type.Literal('form'), id: Id, title: Title,
  fields: Type.Array(UiField, { minItems: 1, maxItems: 12 }),
  submitLabel: Type.String({ minLength: 1, maxLength: 60 }),
}, { additionalProperties: false });
export type UiForm = Static<typeof UiForm>;

export const UiChoices = Type.Object({
  type: Type.Literal('choices'), id: Id, title: Title,
  options: Type.Array(Type.Object({
    id: Id, label: Label,
    description: Type.Optional(Type.String({ maxLength: 400 })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 12 }),
}, { additionalProperties: false });
export type UiChoices = Static<typeof UiChoices>;

export const UiChart = Type.Object({
  type: Type.Literal('chart'), id: Id, title: Title,
  kind: Type.Union([Type.Literal('bar'), Type.Literal('line')]),
  unit: Type.Optional(Type.String({ maxLength: 40 })),
  series: Type.Array(Type.Object({
    name: Label,
    points: Type.Array(Type.Object({ label: Label, value: Type.Number() }, { additionalProperties: false }), { minItems: 1, maxItems: 60 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 6 }),
}, { additionalProperties: false });
export type UiChart = Static<typeof UiChart>;

export const UiBlock = Type.Union([
  Type.Object({ type: Type.Literal('text'), id: Id, text: Type.String({ minLength: 1, maxLength: 12000 }) }, { additionalProperties: false }),
  UiChart,
  Type.Object({
    type: Type.Literal('comparison'), id: Id, title: Title,
    columns: Type.Array(Label, { minItems: 1, maxItems: 6 }),
    rows: Type.Array(Type.Object({ label: Label, values: Type.Array(Type.String({ maxLength: 2000 }), { minItems: 1, maxItems: 6 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 30 }),
  }, { additionalProperties: false }),
  UiChoices,
  UiForm,
  Type.Object({ type: Type.Literal('html'), id: Id, title: Title, html: Type.String({ minLength: 1, maxLength: 64000 }) }, { additionalProperties: false }),
]);
export type UiBlock = Static<typeof UiBlock>;

/** A presentation is a durable tool result, not executable code or a new document format. */
export const InteractiveUi = Type.Object({
  version: Type.Literal('ghost-ui/1'),
  title: Title,
  blocks: Type.Array(UiBlock, { minItems: 1, maxItems: 12 }),
}, { additionalProperties: false });
export type InteractiveUi = Static<typeof InteractiveUi>;
export type UiValues = Record<string, string | number | boolean>;
export const INTERACTIVE_UI_TOOL = 'present_ui';
export const MAX_INTERACTIVE_UI_BYTES = 131072;

function unique(values: readonly string[], what: string) {
  if (new Set(values).size !== values.length) throw new ContractError([`${what} must be unique`]);
}

function matchesStep(value: number, minimum: number | undefined, step: number | undefined) {
  if (step === undefined) return true;
  const units = (value - (minimum ?? 0)) / step;
  return Number.isFinite(units) && Math.abs(units - Math.round(units)) <= 1e-8 * Math.max(1, Math.abs(units));
}

/** Validate cross-field invariants as well as the provider-facing JSON schema. */
export function parseInteractiveUi(value: unknown): InteractiveUi {
  // Browser previews do not need unsafe-eval to validate generated responses.
  if (!Check(InteractiveUi, value)) throw new ContractError(Errors(InteractiveUi, value).slice(0, 8).map(issue => `${issue.instancePath || '/'} ${issue.message}`));
  const ui = value;
  if (new TextEncoder().encode(JSON.stringify(ui)).byteLength > MAX_INTERACTIVE_UI_BYTES) throw new ContractError(['UI response is too large']);
  unique(ui.blocks.map(block => block.id), 'block ids');
  for (const block of ui.blocks) {
    if (block.type === 'comparison' && block.rows.some(row => row.values.length !== block.columns.length)) throw new ContractError(['comparison rows must match the columns']);
    if (block.type === 'choices') unique(block.options.map(option => option.id), 'choice ids');
    if (block.type === 'chart') {
      unique(block.series.map(series => series.name), 'series names');
      const labels = block.series[0]!.points.map(point => point.label);
      unique(labels, 'point labels');
      for (const series of block.series) {
        if (series.points.length !== labels.length || series.points.some((point, index) => point.label !== labels[index] || !Number.isFinite(point.value))) throw new ContractError(['chart series must have aligned labels and finite values']);
      }
    }
    if (block.type !== 'form') continue;
    unique(block.fields.map(field => field.id), 'field ids');
    for (const field of block.fields) {
      if (field.type === 'number') {
        if ([field.min, field.max, field.step, field.value].some(number => number !== undefined && !Number.isFinite(number))) throw new ContractError(['number fields require finite values']);
        if (field.min !== undefined && field.max !== undefined && field.min > field.max) throw new ContractError(['number minimum exceeds maximum']);
        if (field.value !== undefined && (field.min !== undefined && field.value < field.min || field.max !== undefined && field.value > field.max)) throw new ContractError(['number default is outside its bounds']);
        if (field.value !== undefined && !matchesStep(field.value, field.min, field.step)) throw new ContractError(['number default does not match its step']);
      }
      if (field.type === 'select') {
        unique(field.options.map(option => option.value), 'select values');
        if (field.value !== undefined && !field.options.some(option => option.value === field.value)) throw new ContractError(['select default is not an option']);
      }
    }
  }
  return ui;
}

/** Invalid/unrecognized results remain readable tool text in clients. */
export function readInteractiveUi(text: string): InteractiveUi | null {
  if (text.length > MAX_INTERACTIVE_UI_BYTES) return null;
  try { return parseInteractiveUi(JSON.parse(text)); } catch { return null; }
}

/** User UI actions become ordinary owner messages; they cannot invoke host commands. */
export function formatUiSubmission(ui: InteractiveUi, blockId: string, values: UiValues): string {
  const block = ui.blocks.find(item => item.id === blockId);
  if (!block || block.type !== 'form' && block.type !== 'choices') throw new ContractError(['this block accepts no input']);
  const lines = [`UI 응답 · ${ui.title}`, block.title];
  if (block.type === 'choices') {
    const option = Object.hasOwn(values, 'choice') ? block.options.find(item => item.id === values.choice) : undefined;
    if (!option || Object.keys(values).some(key => key !== 'choice')) throw new ContractError(['unknown choice']);
    lines.push(option.label);
    if (option.description) lines.push(option.description);
  } else {
    if (Object.keys(values).some(key => !block.fields.some(field => field.id === key))) throw new ContractError(['unknown form field']);
    for (const field of block.fields) {
      const value = Object.hasOwn(values, field.id) ? values[field.id] : undefined;
      if (value === undefined || value === '') {
        if (field.required) throw new ContractError([`${field.label}: required`]);
        continue;
      }
      if (field.type === 'text' && (typeof value !== 'string' || value.length > 2000 || field.required && !value.trim())) throw new ContractError([`${field.label}: invalid text`]);
      if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || field.min !== undefined && value < field.min || field.max !== undefined && value > field.max || !matchesStep(value, field.min, field.step))) throw new ContractError([`${field.label}: invalid number`]);
      if (field.type === 'select' && !field.options.some(option => option.value === value)) throw new ContractError([`${field.label}: unknown option`]);
      if (field.type === 'checkbox' && (typeof value !== 'boolean' || field.required && !value)) throw new ContractError([`${field.label}: invalid checkbox`]);
      const display = field.type === 'select' ? field.options.find(option => option.value === value)!.label : value;
      lines.push(`- ${field.label}: ${JSON.stringify(display)}`);
    }
  }
  const text = lines.join('\n');
  if (text.length > 32768) throw new ContractError(['UI submission is too large']);
  return text;
}
