# AbaPay reference agent

A small, open-source agent that pays real bills from its own Celo wallet: Nigerian airtime,
mobile data, electricity, cable TV and exam PINs. It pays through
[AbaPay](https://agents.abapays.com) with [x402](https://x402.org): it asks for the price, gets
an HTTP 402 back, signs a USDC, USD₮ or USA₮ authorization for exactly that amount, and retries. There
is no account, no API key and no CELO for gas.

Use it as-is from the terminal, in plain English (Claude decides which tools to call), or as a
starting point for your own agent. MIT licensed.

**Safety:**
- A **spending cap** (`MAX_USD`, $1 by default): nothing above it is ever signed.
- **Approval:** each payment shows its exact price and waits for your yes, unless you pass `--yes`.
- **Plan prices:** for data, cable and exam plans, the price comes from AbaPay's plan list, not from the model.

## Quickstart (under 10 minutes)

You need Node.js 20.6 or newer and about $1 of USDC, USD₮ or USA₮ on Celo.

```bash
git clone https://github.com/investorphem/abapay-reference-agent
cd abapay-reference-agent
npm install
cp .env.example .env

npm run agent -- new-wallet          # prints PRIVATE_KEY=… and an address
```

1. Paste the `PRIVATE_KEY=…` line into `.env`.
2. Send about $1 of **USDC, USD₮ or USA₮ on Celo** to the printed address (MiniPay, Valora, or any
   exchange that withdraws to Celo). You don't need CELO.
3. Check it arrived, look at a price, then pay:

```bash
npm run agent -- wallet
npm run agent -- quote airtime mtn 08031234567 100     # ₦100 of MTN airtime, no payment
npm run agent -- pay   airtime mtn 08031234567 100     # shows the price, asks, pays
```

The result includes the Celo transaction (`celoscan`) and AbaPay's status. Airtime arrives on
the number in seconds.

### Plain English (optional)

Add `ANTHROPIC_API_KEY` to `.env`, then:

```bash
npm run agent -- ask "buy the cheapest MTN daily data plan for 08031234567"
npm run agent -- ask "what's my balance?"
```

Claude can look up your wallet, plans and prices. To pay, it calls `pay_bill`, which still
enforces the cap and asks you at the terminal before signing. The model never sees your key.

## Commands

| Command | What it does |
| --- | --- |
| `new-wallet` | Make a fresh key and address |
| `wallet` | Address and USDC/USD₮/USA₮ balances on Celo |
| `plans <service>` | Plans and prices, e.g. `mtn-data`, `dstv`, `waec` |
| `quote <category> <service> <account> [naira] [--plan CODE]` | Price in dollars, without paying |
| `pay <category> <service> <account> [naira] [--plan CODE] [--yes]` | Pay (within the cap) |
| `ask "<request>"` | Plain-English request, via Claude |

Options: `--token USDC|USDT|USAT`, `--phone N` (receipt phone for electricity and cable),
`--meter prepaid|postpaid`.

Examples:

```bash
npm run agent -- pay data mtn-data 08031234567 --plan mtn-10mb-100
npm run agent -- pay electricity ikeja-electric 45012345678 1000 --meter prepaid --phone 08031234567
npm run agent -- plans dstv
```

Electricity and cable carry a ₦100 service fee, which the quote includes. Set `MAX_USD` to
cover the bill.

Services: `mtn`, `airtel`, `glo`, `etisalat` (9mobile) for airtime; the same with `-data` for
data; `ikeja-electric`, `eko-electric`, `abuja-electric`, `ibadan-electric`, `kano-electric`,
`portharcourt-electric` and the other DisCos; `dstv`, `gotv`, `startimes`; `waec`, `jamb`.

## Self Agent ID (optional)

If you've registered your agent at [app.ai.self.xyz](https://app.ai.self.xyz), put its key in
`SELF_AGENT_KEY`. Every request is then signed with it (`x-self-agent-*` headers), and AbaPay
records the payment as coming from a human-backed agent. The result shows
`"self_agent": "verified"`. The agent key doesn't need to be the paying wallet.

## How it works

- `src/abapay.mjs` is the agent's three abilities: wallet, plans, and quote/pay. Payments go
  through [`abapay-sdk`](https://www.npmjs.com/package/abapay-sdk)'s `payBillViaX402`. Its
  `confirm` hook sees the exact price before anything is signed, and that's where the cap and
  your approval are checked.
- `src/ask.mjs` is the Claude tool-use loop.
- `src/cli.mjs` is the terminal front end.

To build your own agent, copy `src/abapay.mjs` and call `payBill()`. The wire format is
documented at [agents.abapays.com/x402](https://agents.abapays.com/x402).

## If something goes wrong

- **A delivery fails after payment:** AbaPay queues a refund of the same token to the paying
  wallet. An AbaPay operator approves it, and it's paid on-chain. The `request_id` in the result is
  your reference for [support](https://www.abapays.com).
- **`OVER_CAP`:** the bill costs more than `MAX_USD`. Raise the cap in `.env` if you mean it.
- **Keys:** this is a hot wallet. Keep only what you plan to spend in it, and never commit `.env`.

## License

MIT, see [LICENSE](LICENSE).
