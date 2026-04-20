// api/create-order.js — Bộ Luận Giải Nhân Sinh
// CommonJS – fetch thuần, không npm packages

const PACKAGES = {
  html:  { name: 'Bộ Luận Giải Nhân Sinh — Tài liệu số HTML', price: 299000 },
  mp3:   { name: 'Bộ Luận Giải Nhân Sinh — Học liệu âm thanh MP3', price: 299000 },
  combo: { name: 'Bộ Luận Giải Nhân Sinh — Combo HTML + MP3', price: 399000 },
};

function generateOrderCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return 'LGNS' + s;
}

async function kvGet(key) {
  const r = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
  const data = await r.json();
  return data.result;
}

async function kvSet(key, value, ex) {
  await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['SET', key, value, 'EX', ex]),
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, phone, pkg } = req.body || {};
  if (!name || !email || !phone) {
    return res.status(400).json({ error: 'Thiếu thông tin: name, email, phone' });
  }
  if (!pkg || !PACKAGES[pkg]) {
    return res.status(400).json({ error: 'Gói không hợp lệ' });
  }

  const { name: pkgName, price } = PACKAGES[pkg];
  const orderCode = generateOrderCode();
  const acbAccount  = process.env.ACB_ACCOUNT  || '20176968';
  const accountName = process.env.ACCOUNT_NAME || 'HANADOLA MEDIA AND TECHNOLOGY';

  const orderData = {
    orderCode, name, email, phone,
    pkg, pkgName, amount: price,
    status: 'pending',
    createdAt: Date.now(),
  };

  await kvSet(`order:${orderCode}`, JSON.stringify(orderData), 7200);
  console.log('[CreateOrder]', orderCode, '|', pkg, '|', price, '|', email);

  const qrUrl =
    `https://img.vietqr.io/image/ACB-${acbAccount}-compact2.png` +
    `?amount=${price}&addInfo=${encodeURIComponent('LGNS ' + orderCode)}&accountName=${encodeURIComponent(accountName)}`;

  return res.status(200).json({
    success: true,
    orderCode,
    amount: price,
    pkgName,
    bankCode: 'ACB',
    bankAccount: acbAccount,
    accountName,
    description: `LGNS ${orderCode}`,
    qrUrl,
  });
};
