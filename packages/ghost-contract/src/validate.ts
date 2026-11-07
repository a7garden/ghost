import type { Static, TSchema } from "typebox";
import { Compile } from "typebox/compile";

export class ContractError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(issues.join("; "));
    this.name = "ContractError";
  }
}

const compiled = new WeakMap<TSchema, ReturnType<typeof Compile>>();

function checker(schema: TSchema) {
  let check = compiled.get(schema);
  if (!check) {
    check = Compile(schema);
    compiled.set(schema, check);
  }
  return check;
}

/** True when `value` matches `schema`. */
export function validate<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
  return checker(schema).Check(value);
}

/** Returns `value` typed by `schema`, or throws ContractError listing at most eight issues. */
export function parse<T extends TSchema>(schema: T, value: unknown): Static<T> {
  const check = checker(schema);
  if (check.Check(value)) return value as Static<T>;
  const issues = [...check.Errors(value)].slice(0, 8).map((error) => `${error.instancePath || "/"} ${error.message}`);
  throw new ContractError(issues.length > 0 ? issues : ["invalid value"]);
}
