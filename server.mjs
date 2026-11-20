// npm i express merchantid
// Jalankan dulu (sekali, di terminal privat):
//   npx merchantid login shopee
//   npx merchantid set-store <storeId>      (kalau multi-store)
//   npx merchantid set-qris shopee          (tempel QRIS statis toko)
// Lalu: node server.mjs

import express from "express";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ShopeeProvider, MerchantIdError } from "merchantid";

const CONFIG_PATH =
  process.env.MERCHANTID_CONFIG ?? join(homedir(), ".merchantid", "config.json");
const API_KEY = process.env.API_KEY; // wajib, supaya endpoint tidak terbuka bebas
if (!API_KEY) throw new Error("Set env API_KEY dulu");

// ---- load sesi hasil `merchantid login shopee` ----
const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
const cfg = config.providers?.shopee;
if (!cfg?.session) throw new Error("Belum login. Jalankan: npx merchantid login shopee");
if (!cfg.staticQris) throw new Error("QRIS belum di-set. Jalankan: npx merchantid set-qris shopee");

const shopee = new ShopeeProvider({
  session: cfg.session,
  staticQris: cfg.staticQris,
  staticQrisScope: cfg.staticQrisScope,
  // token Shopee berotasi tiap refresh -> wajib disimpan lagi
  onSessionUpdated: async (session) => {
    config.providers.shopee.session = session;
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  },
});

// ---- polling rekonsiliasi di background ----
const payments = shopee.payments();
payments.on("paid", (p) => {
  console.log("[shopee] LUNAS", p.reference, p.uniqueAmount);
  // TODO: update order di database / kirim webhook ke sistem kamu
});
payments.on("expired", (p) => console.log("[shopee] expired", p.reference));
payments.on("error", (e) => console.error("[shopee] polling error:", e.code ?? e.message));
payments.start();

// ---- HTTP ----
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (req.get("x-api-key") !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
});

const handleError = (res, err) => {
  if (err instanceof MerchantIdError) {
    const status = err.code === "CONFIG_INVALID" ? 400
      : err.code === "AMOUNT_POOL_EXHAUSTED" ? 429
      : err.code === "AUTH_REQUIRED" || err.code === "AUTH_FAILED" ? 503
      : 502;
    return res.status(status).json({ error: err.code, message: err.message });
  }
  console.error(err);
  return res.status(500).json({ error: "INTERNAL" });
};

// Buat QRIS dinamis ShopeePay
// POST /shopee/create  { "amount": 10000, "reference": "order-42" }
app.post("/shopee/create", async (req, res) => {
  try {
    const { amount, reference } = req.body ?? {};
    if (!Number.isSafeInteger(amount) || amount < 1) {
      return res.status(400).json({ error: "amount harus integer rupiah > 0" });
    }
    const payment = await shopee.createPayment({ amount, reference });
    res.status(201).json(payment); // berisi id, uniqueAmount, qrString, dst.
  } catch (err) { handleError(res, err); }
});

// Cek status
// GET /shopee/status/:id
app.get("/shopee/status/:id", async (req, res) => {
  try {
    const payment = await shopee.payments().getPayment(req.params.id);
    if (!payment) return res.status(404).json({ error: "not found" });
    res.json(payment);
  } catch (err) { handleError(res, err); }
});

// Batalkan pembayaran pending
// POST /shopee/cancel/:id
app.post("/shopee/cancel/:id", async (req, res) => {
  try {
    await shopee.payments().cancelPayment(req.params.id);
    res.json({ ok: true });
  } catch (err) { handleError(res, err); }
});

const port = process.env.PORT ?? 3000;
app.listen(port, () => console.log(`ShopeePay endpoint di :${port}`));

process.on("SIGINT", () => { payments.stop(); process.exit(0); });
