// The agent's three abilities: see its wallet, look up plans, and pay a bill. Everything that
// moves money goes through payBill(), which enforces the spending cap before anything is signed.

import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { payBillViaX402, AbaPayError } from "abapay-sdk";

export const ABAPAY = process.env.ABAPAY_URL || "https://agents.abapays.com";

// Celo mainnet stablecoins AbaPay accepts over x402 (both 6 decimals, EIP-3009).
export const TOKENS = {
  USDC: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
  USDT: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
};

const CATEGORIES = ["AIRTIME", "DATA", "ELECTRICITY", "CABLE", "EDUCATION"];

const celoClient = createPublicClient({ chain: celo, transport: http(process.env.CELO_RPC_URL) });

function key(name) {
  const k = process.env[name];
  if (!k) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${name} must be a 0x-prefixed 32-byte hex private key.`);
  return k;
}

export function account() {
  const k = key("PRIVATE_KEY");
  if (!k) throw new Error("Set PRIVATE_KEY in .env (make one with: npm run agent -- new-wallet).");
  return privateKeyToAccount(k);
}

export function selfAgent() {
  const k = key("SELF_AGENT_KEY");
  return k ? privateKeyToAccount(k) : undefined;
}

export function maxUsd() {
  const n = Number(process.env.MAX_USD ?? 1);
  if (!Number.isFinite(n) || n <= 0) throw new Error("MAX_USD must be a positive number of dollars.");
  return n;
}

export function defaultToken() {
  const t = String(process.env.TOKEN || "USDC").toUpperCase();
  if (!(t in TOKENS)) throw new Error("TOKEN must be USDC or USDT.");
  return t;
}

/** The paying wallet's address and its Celo stablecoin balances. */
export async function wallet() {
  const { address } = account();
  const balances = {};
  for (const [symbol, token] of Object.entries(TOKENS)) {
    const raw = await celoClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    balances[symbol] = formatUnits(raw, 6);
  }
  return { address, chain: "Celo", balances, self_agent: selfAgent()?.address ?? null };
}

/** Plans for a DATA, CABLE or EDUCATION service, e.g. "mtn-data", "dstv", "waec". */
export async function plans(serviceID) {
  const res = await fetch(`${ABAPAY}/api/variations?serviceID=${encodeURIComponent(serviceID)}`);
  const data = await res.json().catch(() => null);
  const list = data?.content?.variations ?? data?.content?.varations;
  if (!res.ok || !Array.isArray(list)) throw new Error(`No plans found for "${serviceID}".`);
  return list.map((v) => ({ code: v.variation_code, name: v.name, naira: Number(v.variation_amount) }));
}

/**
 * Build the bill AbaPay's x402 endpoint expects. For a plan, the price comes from the plan
 * itself, so the agent can never pay a plan code with a made-up amount.
 */
export async function bill({ category, service, account: billersCode, naira, plan, phone, meterType, token }) {
  category = String(category || "").toUpperCase();
  if (!CATEGORIES.includes(category)) throw new Error(`category must be one of ${CATEGORIES.join(", ")}.`);
  if (!service) throw new Error("service is required, e.g. mtn, mtn-data, ikeja-electric, dstv.");
  if (!billersCode) throw new Error("account is required: the phone, meter or smartcard number.");
  let amount = Number(naira);
  if (plan) {
    const p = (await plans(service)).find((x) => x.code === plan);
    if (!p) throw new Error(`"${plan}" is not a plan of ${service}. List them with: npm run agent -- plans ${service}`);
    amount = p.naira;
  }
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("A naira amount (or a plan) is required.");
  // The operator for airtime/data ("mtn-data" → "MTN"); the provider itself otherwise ("IKEJA-ELECTRIC").
  const network = (category === "AIRTIME" || category === "DATA" ? service.split("-")[0] : service).toUpperCase();
  return {
    serviceID: service.toLowerCase(),
    serviceCategory: category,
    network,
    billersCode: String(billersCode),
    nairaAmount: amount,
    token: token ? String(token).toUpperCase() : defaultToken(),
    ...(plan ? { variation_code: plan } : {}),
    ...(phone ? { phone: String(phone) } : {}),
    ...(meterType ? { meter_account_type: meterType } : {}),
  };
}

/** The price of a bill, without paying: AbaPay's 402 challenge, read and not answered. */
export async function quote(details) {
  const b = await bill(details);
  const address = process.env.PRIVATE_KEY ? account().address : "0x000000000000000000000000000000000000dEaD";
  const res = await fetch(`${ABAPAY}/api/pay/x402`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...b, wallet_address: address }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status !== 402) throw new Error(data.message || data.error || `Expected a 402 price, got HTTP ${res.status}.`);
  const asset = TOKENS[b.token].toLowerCase();
  const offer = (data.accepts || []).find((a) => a.network === "eip155:42220" && String(a.asset).toLowerCase() === asset);
  if (!offer) throw new Error(`AbaPay offered no ${b.token} price on Celo for this bill.`);
  return { naira: b.nairaAmount, usd: Number(offer.amount) / 1e6, token: b.token, within_cap: Number(offer.amount) / 1e6 <= maxUsd() };
}

/**
 * Pay a bill. `approve(price)` is asked once the exact price is known and before anything is
 * signed; the cap is checked first and cannot be overridden by approve().
 */
export async function payBill(details, { approve = async () => true } = {}) {
  const cap = maxUsd();
  let priced = null;
  try {
    const result = await payBillViaX402({
      signer: account(),
      selfAgent: selfAgent(),
      baseUrl: ABAPAY,
      bill: await bill(details),
      confirm: async (offer) => {
        const usd = Number(offer.amount) / 1e6;
        priced = { usd, token: offer.token };
        if (usd > cap) return false;
        return approve(priced);
      },
    });
    return {
      ok: result.success !== false,
      status: result.status,
      price_usd: priced?.usd,
      tx_hash: result.tx_hash ?? null,
      celoscan: result.tx_hash ? `https://celoscan.io/tx/${result.tx_hash}` : null,
      token_or_units: result.purchased_code || result.units || null,
      request_id: result.request_id ?? null,
      self_agent: result.self_agent?.status ?? null,
      message: result.message ?? null,
    };
  } catch (e) {
    if (priced && priced.usd > cap) {
      return { ok: false, status: "OVER_CAP", price_usd: priced.usd, message: `Costs $${priced.usd.toFixed(4)}, above MAX_USD=$${cap}. Nothing was paid.` };
    }
    if (priced && e instanceof AbaPayError && /declined before signing/.test(e.message)) {
      return { ok: false, status: "DECLINED", price_usd: priced.usd, message: "Declined. Nothing was paid." };
    }
    const detail = e instanceof AbaPayError && e.response ? e.response.message || e.response.errorCode : null;
    return { ok: false, status: "ERROR", message: [e.message, detail].filter(Boolean).join(" — ") };
  }
}
