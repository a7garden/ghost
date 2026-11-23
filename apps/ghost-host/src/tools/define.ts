import { defineTool as defineDurableTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Static, TSchema } from "typebox";

type Declaration<T extends TSchema, D extends JsonValue, C extends JsonValue> = Omit<ToolRegistration<any, D, C>, "parameters" | "execute" | "cancel" | "prepareArguments"> & {
  parameters: T;
  execute(args: Static<T>, api: Parameters<ToolRegistration<any, D, C>["execute"]>[1], context: Parameters<ToolRegistration<any, D, C>["execute"]>[2]): ReturnType<ToolRegistration<any, D, C>["execute"]>;
  cancel?(args: Static<T>, api: Parameters<ToolRegistration<any, D, C>["execute"]>[1], context: Parameters<ToolRegistration<any, D, C>["execute"]>[2]): Promise<void>;
  prepareArguments?(args: unknown): Static<T>;
};

/**
 * Ghost declares tool parameters with TypeBox, the schema library of its contract and API. Pi validates any JSON Schema,
 * but types `args` only for its own builders, so this wrapper restores TypeBox's static type at the one boundary.
 */
export function defineTool<T extends TSchema, D extends JsonValue = JsonValue, C extends JsonValue = JsonValue>(tool: Declaration<T, D, C>): ToolRegistration<any, D, C> {
  return defineDurableTool(tool as unknown as ToolRegistration<any, D, C>);
}
