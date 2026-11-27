const NO_PROJECT = '-';

/** The section entry has no project; a literal '-' names the unscoped roster. */
export function workbenchPath(scopeId: string | null, view = ''): string {
  return `/coding/${scopeId === null ? NO_PROJECT : encodeURIComponent(scopeId)}${view ? `?${view}` : ''}`;
}

/** Undefined means the Host chooses the project; null is an explicit unscoped route. */
export function workbenchScope(rawId: string | undefined): string | null | undefined {
  return rawId === NO_PROJECT ? null : rawId === undefined ? undefined : decodeURIComponent(rawId);
}

export const workbenchSessionPath = (scopeId: string | null, id: string) => workbenchPath(scopeId, `session=${encodeURIComponent(id)}`);
