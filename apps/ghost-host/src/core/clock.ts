/**
 * The Host's clock.
 *
 * A Ghost has no clock of its own: given a page, a file or a mail, it reads a timestamp
 * out of it and answers as if that were the present. The Host stamps every turn it
 * admits, so the model always holds an authoritative "now" and never has to guess one
 * out of foreign data.
 */

/** The owner's timezone, named so the stamp does not depend on the Mac's clock settings. */
export const OWNER_TIME_ZONE = "Asia/Seoul";

/** The tag that marks the Host's stamp inside a turn. */
export const CLOCK_MARKER = "<host-clock>";

/**
 * The moment a turn was admitted: UTC, and the same moment in the owner's timezone.
 * The local part is the one the owner would say out loud.
 */
export function clockStamp(at: number = Date.now()): string {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: OWNER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at));
  return `${CLOCK_MARKER} ${new Date(at).toISOString()} · ${local.replace(",", "")} ${OWNER_TIME_ZONE}`;
}

/** The stamp as the Host appends it to a turn's text. */
export function withClockStamp(text: string, at: number = Date.now()): string {
  return `${text}\n\n${clockStamp(at)}`;
}

/** What the transcript shows: the text without the Host's trailing stamp. */
export function withoutClockStamp(text: string): string {
  const index = text.lastIndexOf(`\n\n${CLOCK_MARKER} `);
  return index === -1 || text.indexOf("\n", index + 2) !== -1 ? text : text.slice(0, index);
}

/**
 * What every Ghost is told about the clock, once, in the instructions. The stamp
 * itself is per turn; this rule is static, so it never breaks the prompt cache.
 */
export const CLOCK_INSTRUCTIONS = `Every turn the Host admits carries a ${CLOCK_MARKER} line: the moment that turn started, in UTC and in the owner's timezone (${OWNER_TIME_ZONE}). That line is the present. A timestamp you read in a page, a file, a mail or a web result is data about the past; never answer "now", "today" or "the current time" from it.`;
