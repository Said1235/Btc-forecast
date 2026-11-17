# BTC Forecast

Daily BTCUSDT candle prediction game (UP / DOWN / FLAT, 1 point per correct call). Points only, no stakes.

Frontend: Vite + React + TypeScript. Market data from the Binance Spot public API. GenLayer contract integration is intentionally not connected yet.

```
npm install
npm run dev          # add ?demo=1 for Demo Mode
npm run build
npm run lint && npm test
npm run test:live    # real Binance request
```

Details and what remains for the contract stage: `docs/FRONTEND_HANDOFF.md`.

## Deploy on Vercel
`vercel.json` is already configured (Vite, `npm run build`, output `dist`).
1. https://vercel.com/new, import `Said1235/Btc-forecast`, press Deploy. No environment variables are needed yet.
2. Open `<your-url>/#/app` and check the LIVE chip.
CLI alternative: `npx vercel` (preview) or `npx vercel --prod`.
