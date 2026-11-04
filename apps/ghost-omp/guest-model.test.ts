import { expect, test } from "bun:test";
import { createOneShotGuestFetch, guestModelFailure } from "./guest-model.ts";

test("SDK retries retain broker rejection and upstream status with one exchange", async () => {
  let calls = 0;
  const fetchOnce = createOneShotGuestFetch(async () => {
    calls++;
    return guestModelFailure("upstream_http_error", 429);
  });
  for (let i = 0; i < 3; i++) {
    const response = await fetchOnce("http://127.0.0.1/v1/chat/completions");
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: {
      type: "ghost_model_broker_error", code: "upstream_http_error",
      message: "Ghost model broker: upstream_http_error (upstream HTTP 429)",
      upstream_http_status: 429,
    } });
  }
  expect(calls).toBe(1);
});

test("concurrent SDK attempts cannot issue a second exchange", async () => {
  let calls = 0;
  let release!: (response: Response) => void;
  const fetchOnce = createOneShotGuestFetch(async () => {
    calls++;
    return new Promise<Response>(resolve => { release = resolve; });
  });
  const first = fetchOnce("http://127.0.0.1/v1/chat/completions");
  const second = fetchOnce("http://127.0.0.1/v1/chat/completions");
  await Promise.resolve();
  release(guestModelFailure("upstream_timeout"));
  const responses = await Promise.all([first, second]);
  expect(await responses[0].text()).toBe(await responses[1].text());
  expect(calls).toBe(1);
});

test("successful response cannot be replayed as a new model request", async () => {
  let calls = 0;
  const fetchOnce = createOneShotGuestFetch(async () => {
    calls++;
    return new Response("completed", { status: 200 });
  });
  expect(await (await fetchOnce("http://127.0.0.1/v1/chat/completions")).text()).toBe("completed");
  await expect(fetchOnce("http://127.0.0.1/v1/chat/completions")).rejects.toThrow("duplicate request blocked");
  expect(calls).toBe(1);
});

test("a thrown transport failure keeps its original cause on SDK retry", async () => {
  const original = new Error("guest broker response binding rejected");
  let calls = 0;
  const fetchOnce = createOneShotGuestFetch(async () => { calls++; throw original; });
  for (let i = 0; i < 2; i++) {
    try { await fetchOnce("http://127.0.0.1/v1/chat/completions"); throw new Error("unexpected success"); }
    catch (error) { expect(error).toBe(original); }
  }
  expect(calls).toBe(1);
});

test("validation failure retains its category without arbitrary response bytes", async () => {
  expect((await guestModelFailure("completion_output_truncated").json()).error.code)
    .toBe("completion_output_truncated");
  const secret = "PRIVATE RESPONSE\ncredential=hidden";
  expect(await guestModelFailure(secret).text()).not.toContain(secret);
});
