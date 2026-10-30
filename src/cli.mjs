#!/usr/bin/env node
// abapay-reference-agent — pay real bills on Celo through AbaPay (x402).
//   npm run agent -- help

import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { wallet, plans, quote, payBill, maxUsd } from "./abapay.mjs";

const HELP = `abapay-reference-agent — pay real bills on Celo through AbaPay (x402)

  npm run agent -- new-wallet
  npm run agent -- wallet
  npm run agent -- plans <service>                       e.g. mtn-data, dstv
  npm run agent -- quote <category> <service> <account> [naira] [--plan CODE]
  npm run agent -- pay   <category> <service> <account> [naira] [--plan CODE] [--yes]
  npm run agent -- ask "buy 100 naira of MTN airtime for 08031234567"

  category: airtime | data | electricity | cable | education
  options:  --plan CODE  --token USDC|USDT|USAT  --phone N  --meter prepaid|postpaid  --yes

Spending cap: MAX_USD in .env (now $${process.env.MAX_USD ?? 1}). Every payment shows its exact
price and asks before signing unless --yes is given; nothing above the cap is ever signed.`;

const print = (o) => console.log(typeof o === "string" ? o : JSON.stringify(o, null, 2));

async function approveAtTerminal({ usd, token }) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Pay $${usd.toFixed(4)} in ${token} on Celo? [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      plan: { type: "string" },
      token: { type: "string" },
      phone: { type: "string" },
      meter: { type: "string" },
      yes: { type: "boolean", default: false },
    },
  });
  const [cmd, ...rest] = positionals;
  const details = () => {
    const [category, service, account, naira] = rest;
    return { category, service, account, naira, plan: values.plan, token: values.token, phone: values.phone, meterType: values.meter };
  };

  switch (cmd) {
    case "new-wallet": {
      const key = generatePrivateKey();
      print(`PRIVATE_KEY=${key}\naddress: ${privateKeyToAccount(key).address}\n\nPut the line above in .env, then send about $1 of USDC, USDT or USAT (USA₮) to the address on Celo.`);
      return;
    }
    case "wallet":
      return print(await wallet());
    case "plans":
      if (!rest[0]) throw new Error("Usage: plans <service>, e.g. plans mtn-data");
      return print(await plans(rest[0]));
    case "quote":
      return print(await quote(details()));
    case "pay": {
      const result = await payBill(details(), { approve: values.yes ? async () => true : approveAtTerminal });
      print(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "ask": {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY in .env for plain-English requests.");
      const { ask } = await import("./ask.mjs");
      return print(await ask(rest.join(" "), { approve: values.yes ? async () => true : approveAtTerminal }));
    }
    default:
      maxUsd();
      return print(HELP);
  }
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
});
