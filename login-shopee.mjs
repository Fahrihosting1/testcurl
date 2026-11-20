// Pakai: node login-shopee.mjs 628xxxxxxxxxx
// Opsional: taruh device report hasil tangkapan browser KAMU SENDIRI di device-report.txt
//
// Hasil: sesi + QRIS disimpan ke ~/.merchantid/config.json (format sama dengan CLI),
// jadi server.mjs bisa langsung dipakai.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { ShopeeProvider, CaptchaRequiredError } from "merchantid";

const CONFIG_PATH =
  process.env.MERCHANTID_CONFIG ?? join(homedir(), ".merchantid", "config.json");

const phone = process.argv[2];
if (!phone || !/^62\d{8,13}$/.test(phone)) {
  console.error("Pakai: node login-shopee.mjs 628xxxxxxxxxx");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => rl.question(q);

let deviceReport;
if (existsSync("device-report.txt")) {
  deviceReport = (await readFile("device-report.txt", "utf8")).trim();
  console.log("device-report.txt dipakai.");
} else {
  console.log("device-report.txt tidak ada, login tanpa device report (OTP bisa saja tidak terkirim).");
}

let session;
const shopee = new ShopeeProvider({
  ...(deviceReport ? { deviceReport } : {}),
  onSessionUpdated: async (s) => { session = s; },
});

try {
  const password = await ask("Password akun Shopee Merchant: ");
  const challenge = await shopee.requestOtp(phone, { password });
  console.log("OTP diminta. Cek WhatsApp / SMS / telepon. Kalau 2 menit tidak masuk, tekan Ctrl+C.");

  const otp = await ask("Kode OTP: ");
  const outcome = await shopee.loginWithOtp({ challenge, otp });

  let verification = outcome.verification;
  if (outcome.status === "merchant-selection-required") {
    outcome.merchants.forEach((m, i) => console.log(`${i + 1}. ${m.name} (${m.id})`));
    const idx = Number(await ask("Pilih merchant (nomor): ")) - 1;
    const chosen = outcome.merchants[idx];
    if (!chosen) throw new Error("Pilihan tidak valid");
    await shopee.completeLogin({ verification, merchantId: chosen.id });
  }

  if (!shopee.session?.storeId && !session?.storeId) {
    const stores = await shopee.listStores();
    stores.forEach((s, i) => console.log(`${i + 1}. ${s.name ?? s.id} (${s.id})`));
    const idx = Number(await ask("Pilih store (nomor): ")) - 1;
    const chosen = stores[idx];
    if (!chosen) throw new Error("Pilihan tidak valid");
    await shopee.selectStore(chosen.id);
  }

  const qris = (await ask("Tempel QRIS statis toko (000201...): ")).trim();
  shopee.setStaticQris(qris);

  // simpan dengan skema yang sama dengan CLI merchantid (version 1)
  let config = { version: 1, providers: {} };
  if (existsSync(CONFIG_PATH)) config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  config.defaultProvider ??= "shopee";
  config.providers ??= {};
  config.providers.shopee = {
    session: session ?? shopee.session,
    staticQris: shopee.staticQris,
    staticQrisScope: shopee.staticQrisScope,
  };
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log("Berhasil. Sesi disimpan di", CONFIG_PATH);
} catch (err) {
  if (err instanceof CaptchaRequiredError) {
    console.error("Shopee minta CAPTCHA. Selesaikan verifikasi lewat aplikasi/situs resmi Shopee Merchant, lalu coba lagi.");
  } else {
    console.error("Gagal:", err.code ?? "", err.message);
  }
  process.exitCode = 1;
} finally {
  rl.close();
}
