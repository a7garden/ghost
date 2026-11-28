/** 「Ghost 추가」: the package catalog. */
export const ghostAddPath = '/ghosts/add';
/** 직접 만들기: a Ghost from a name and a persona. */
export const ghostMakePath = '/ghosts/new';
export const packagePath = (name: string) => `${ghostAddPath}/${encodeURIComponent(name)}`;
/** A new project the given Ghost receives. */
export const newProjectPath = (ghostId: string) => `/scopes?new=1&ghost=${encodeURIComponent(ghostId)}`;
