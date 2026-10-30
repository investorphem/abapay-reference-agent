// Offline checks of the parts that decide what gets paid: bill building and the spending cap.
// No network, no real key: fetch is stubbed with AbaPay's real 402 shape.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.PRIVATE_KEY = "0x" + "11".repeat(32);
const { bill, payBill } = await import("../src/abapay.mjs");

const offer = (network, asset, name, amount = "76758") => ({
  scheme: "exact", network, amount, maxAmountRequired: amount, payTo: "0x5df8aE2B963165b735B18Ca86B1ea448d2AA032C",
  asset, maxTimeoutSeconds: 3600, extra: { name, version: "2", primaryType: "TransferWithAuthorization" },
});
const challenge = (amount) => ({
  x402Version: 2, error: "Payment required",
  accepts: [offer("eip155:42220", "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", "USDC", amount)],
});

let calls;
beforeEach(() => {
  calls = [];
  process.env.MAX_USD = "1";
  process.env.TOKEN = "USDC";
});
function stub(...responses) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const [status, body] = responses.shift();
    return new Response(JSON.stringify(body), { status });
  };
}

test("airtime: operator as network, naira as given", async () => {
  assert.deepEqual(await bill({ category: "airtime", service: "MTN", account: "08031234567", naira: 100 }), {
    serviceID: "mtn", serviceCategory: "AIRTIME", network: "MTN", billersCode: "08031234567", nairaAmount: 100, token: "USDC",
  });
});

test("data plan: the price comes from the plan list, not the caller", async () => {
  stub([200, { content: { variations: [{ variation_code: "mtn-10mb-100", name: "110MB", variation_amount: "100.00" }] } }]);
  const b = await bill({ category: "data", service: "mtn-data", account: "08031234567", naira: 5, plan: "mtn-10mb-100" });
  assert.equal(b.nairaAmount, 100);
  assert.equal(b.network, "MTN");
  assert.equal(b.variation_code, "mtn-10mb-100");
});

test("electricity: provider as network, meter type passed through", async () => {
  const b = await bill({ category: "electricity", service: "ikeja-electric", account: "45012345678", naira: 1000, meterType: "prepaid", phone: "08031234567" });
  assert.equal(b.network, "IKEJA-ELECTRIC");
  assert.equal(b.meter_account_type, "prepaid");
});

test("refuses an unknown category or a missing amount", async () => {
  await assert.rejects(bill({ category: "loans", service: "x", account: "1", naira: 1 }), /category/);
  await assert.rejects(bill({ category: "airtime", service: "mtn", account: "1" }), /amount/);
});

test("over the cap: nothing is signed and only the price was asked", async () => {
  process.env.MAX_USD = "0.05";
  stub([402, challenge("76758")]);
  const r = await payBill({ category: "airtime", service: "mtn", account: "08031234567", naira: 100 });
  assert.equal(r.status, "OVER_CAP");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers["X-PAYMENT"], undefined);
});

test("declined at the prompt: nothing is signed", async () => {
  stub([402, challenge("76758")]);
  const r = await payBill({ category: "airtime", service: "mtn", account: "08031234567", naira: 100 }, { approve: async () => false });
  assert.equal(r.status, "DECLINED");
  assert.equal(calls.length, 1);
});

test("approved within the cap: signs and returns the celoscan link", async () => {
  const tx = "0x" + "ab".repeat(32);
  stub([402, challenge("76758")], [200, { success: true, status: "SUCCESS", tx_hash: tx, request_id: "r1" }]);
  const r = await payBill({ category: "airtime", service: "mtn", account: "08031234567", naira: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.price_usd, 0.076758);
  assert.equal(r.celoscan, `https://celoscan.io/tx/${tx}`);
  assert.ok(calls[1].init.headers["X-PAYMENT"]);
});

test("TOKEN=USAT: picks USA₮ out of a multi-token 402 and pays with it", async () => {
  process.env.TOKEN = "USAT";
  const usdc = offer("eip155:42220", "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", "USDC", "76758");
  const usat = { ...offer("eip155:42220", "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771", "Tether America USD", "76700"), extra: { name: "Tether America USD", version: "1", primaryType: "TransferWithAuthorization" } };
  const tx = "0x" + "cd".repeat(32);
  stub([402, { x402Version: 2, error: "Payment required", accepts: [usdc, usat] }], [200, { success: true, status: "SUCCESS", tx_hash: tx, request_id: "r2" }]);
  const r = await payBill({ category: "airtime", service: "mtn", account: "08031234567", naira: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.price_usd, 0.0767);
  const paid = JSON.parse(Buffer.from(calls.at(-1).init.headers["X-PAYMENT"], "base64").toString());
  assert.equal(paid.payload.authorization.value, "76700");
});
