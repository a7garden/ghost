import { Type } from "typebox";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { CommandError, forbidden, invalid } from "../core/errors.ts";
import { TOSS_ORIGIN, tossErrorCode, tossQuery, tossRoute, type TossCredential, type TossPort } from "../integrations/toss.ts";
import { errorResult, requireAllowed } from "./shared.ts";

export const TOSS_INSTRUCTIONS = `toss_read reads the owner's Toss Securities (토스증권) brokerage, read-only: accounts, holdings, transactions, orders, buying power and KR/US market data. It cannot place, modify or cancel orders; say so instead of trying. Start with path /api/v1/accounts to learn each accountSeq, then pass it as account for account routes. The owner's holdings and transactions are private: use them for the owner's own questions, never in messages to anyone else.`;

/** The rendered result stays within this many characters. */
const MAX_RESULT_CHARS = 48_000;

const DESCRIPTION = `GET one Toss Securities Open API read route (https://openapi.tossinvest.com/openapi-docs/overview.md) and return its JSON. Read-only; orders cannot be placed.
Account routes (need account = accountSeq from /api/v1/accounts): /api/v1/holdings [symbol], /api/v1/transactions [transactionTypes,from,to,cursor,limit], /api/v1/orders [status=OPEN|CLOSED,symbol,from,to,cursor,limit], /api/v1/orders/{orderId}, /api/v1/conditional-orders [status,symbol,cursor,limit], /api/v1/conditional-orders/{id}, /api/v1/buying-power [currency], /api/v1/sellable-quantity [symbol], /api/v1/commissions.
Other routes: /api/v1/accounts, /api/v1/prices [symbols=005930,AAPL], /api/v1/orderbook [symbol], /api/v1/trades [symbol,count], /api/v1/price-limits [symbol], /api/v1/candles [symbol,interval,count,before,adjusted], /api/v1/stocks [symbols], /api/v1/stocks/all [market,status,securityType,commonShare], /api/v1/stocks/{symbol}/(warnings|investor-trading|program-trades|short-selling|credit-trades|securities-lending), /api/v1/exchange-rate [dateTime,baseCurrency,quoteCurrency], /api/v1/market-calendar/KR|US [date], /api/v1/rankings [type,marketCountry,duration,excludeInvestmentCaution,count], /api/v1/rankings/investor-trading, /api/v1/market-indicators/prices [symbols], /api/v1/market-indicators/{symbol}/(candles|investor-trading), /api/v1/sectors, /api/v1/sectors/rankings, /api/v1/sectors/{sectorId}[/stocks|/etfs].
query is a URL query string such as "symbols=005930,000660" (lists comma-separated). Paged results return nextCursor; pass it back as cursor.`;

const text = (message: string): ToolExecutionResult => ({ content: [{ type: "text", text: message }] });

/** Toss's own words for a refusal, without echoing anything but its error code and message. */
function failure(status: number, body: string, retryAfter: string | null): CommandError {
  const code = tossErrorCode(body);
  if (code === "ip-not-allowed") return forbidden("Toss refused this Mac's IP address; the owner registers its public IP under 토스증권 WTS › 설정 › Open API › 허용 IP 관리");
  let message = "";
  try {
    const parsed: unknown = JSON.parse(body);
    const error = parsed && typeof parsed === "object" && "error" in parsed ? parsed.error : undefined;
    const raw = error && typeof error === "object" && "message" in error ? error.message : undefined;
    if (typeof raw === "string") message = raw.slice(0, 512);
  } catch { /* not the documented envelope */ }
  const detail = `Toss ${status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`;
  if (status === 429) return new CommandError("unavailable", `${detail}. Rate limited${retryAfter ? `; retry after ${retryAfter}s` : ""}.`);
  return new CommandError(status >= 500 ? "unavailable" : "invalid", detail);
}

/** The owner's Toss Securities accounts and market data, through the API key the owner granted in the vault. */
export function createTossTools(core: Core, vault: { apiCredential(ghostId: string, origin: string): TossCredential }, toss: TossPort): Extension {
  return defineExtension({
    name: "ghost.toss",
    tools: [
      defineTool({
        name: "toss_read", description: DESCRIPTION, replay: "safe",
        parameters: Type.Object({
          path: Type.String({ minLength: 1, maxLength: 256, description: "Route path starting with /api/v1/" }),
          query: Type.Optional(Type.String({ maxLength: 4096, description: "URL query string without the leading ?" })),
          account: Type.Optional(Type.Integer({ minimum: 0, description: "accountSeq; required exactly for account routes" })),
        }),
        async execute(args, api, context) {
          try {
            const scope = requireAllowed(core, api, "toss_read");
            const route = tossRoute(args.path);
            if (route.account && args.account === undefined) throw invalid("this route needs account: call /api/v1/accounts and pass its accountSeq");
            const query = tossQuery(args.query);
            const credential = (): TossCredential => {
              try { return vault.apiCredential(scope.ghost.id, TOSS_ORIGIN); }
              catch (error) {
                if (error instanceof CommandError && error.code === "forbidden") throw forbidden(`No Toss Securities API key is granted to ${scope.ghost.name}. Ask the owner once with vault_request (kind "api", origin "${TOSS_ORIGIN}") if you have it, otherwise tell the owner to add one under 금고 and grant it to you.`);
                throw error;
              }
            };
            credential();
            const response = await toss.get(credential, args.path, query, route.account ? args.account! : null, context?.abortSignal);
            if (response.status < 200 || response.status >= 300) throw failure(response.status, response.body, response.retryAfter);
            const body = response.body || "(empty response)";
            return text(body.length <= MAX_RESULT_CHARS ? body : `${body.slice(0, MAX_RESULT_CHARS)}\n[truncated: narrow the query or page with limit/cursor]`);
          } catch (error) { return errorResult(error); }
        },
      }),
    ],
  });
}
