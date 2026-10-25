// Plain-English mode: Claude reads the request, looks things up with the tools below, and asks
// to pay. The model never holds the key and cannot raise the cap: pay_bill runs payBill(), which
// checks MAX_USD and then asks the human at the terminal before signing.

import Anthropic from "@anthropic-ai/sdk";
import { wallet, plans, quote, payBill, maxUsd } from "./abapay.mjs";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

const billSchema = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["AIRTIME", "DATA", "ELECTRICITY", "CABLE", "EDUCATION"] },
    service: { type: "string", description: "Service ID: mtn, airtel, glo, etisalat (= 9mobile) (airtime); mtn-data, airtel-data, glo-data, etisalat-data (data); ikeja-electric, eko-electric, abuja-electric… (electricity); dstv, gotv, startimes (cable); waec, jamb (education)." },
    account: { type: "string", description: "Phone number (airtime, data), meter number (electricity) or smartcard number (cable)." },
    naira: { type: "number", description: "Amount in Nigerian naira. Omit when a plan is given." },
    plan: { type: "string", description: "Plan code from list_plans, for DATA, CABLE and EDUCATION." },
    phone: { type: "string", description: "Customer phone for the receipt (electricity, cable)." },
    meterType: { type: "string", enum: ["prepaid", "postpaid"], description: "ELECTRICITY only." },
  },
  required: ["category", "service", "account"],
};

const tools = [
  { name: "get_wallet", description: "The paying wallet's address and its USDC/USDT balances on Celo.", input_schema: { type: "object", properties: {} } },
  { name: "list_plans", description: "Plans (code, name, naira price) for a DATA, CABLE or EDUCATION service, e.g. mtn-data, dstv.", input_schema: { type: "object", properties: { service: { type: "string" } }, required: ["service"] } },
  { name: "quote", description: "The price in US dollars of a bill, without paying.", input_schema: billSchema },
  { name: "pay_bill", description: "Pay the bill. The person is asked to approve the exact price first; payments above the spending cap are refused.", input_schema: billSchema },
];

export async function ask(request, { approve }) {
  const client = new Anthropic();
  const system = `You are a bill-payment agent for Nigeria. You pay real bills from a Celo wallet through AbaPay, in USDC or USDT. The spending cap is $${maxUsd()} per payment. Check the price with quote before paying. For data, cable and education, pick a plan with list_plans. If something needed is missing (number, amount, network), ask instead of guessing. After paying, report the status, the price and the celoscan link.`;
  const messages = [{ role: "user", content: request }];

  for (let turn = 0; turn < 12; turn++) {
    const res = await client.messages.create({ model: MODEL, max_tokens: 1024, system, tools, messages });
    messages.push({ role: "assistant", content: res.content });
    if (res.stop_reason !== "tool_use") {
      return res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    }
    const results = [];
    for (const call of res.content.filter((b) => b.type === "tool_use")) {
      let out;
      try {
        if (call.name === "get_wallet") out = await wallet();
        else if (call.name === "list_plans") out = (await plans(call.input.service)).slice(0, 40);
        else if (call.name === "quote") out = await quote(call.input);
        else if (call.name === "pay_bill") out = await payBill(call.input, { approve });
        else out = { error: `Unknown tool ${call.name}` };
      } catch (e) {
        out = { error: e.message };
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
  return "Stopped after 12 steps without finishing.";
}
