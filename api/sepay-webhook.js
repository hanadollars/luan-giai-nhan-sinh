// api/sepay-webhook.js — Bộ Luận Giải Nhân Sinh
// CommonJS – fetch thuần, không npm packages

const ORDER_CODE_REGEX = /LGNS[A-Z0-9]{4}/i;
const EINVOICE_BASE = 'https://einvoice-api.sepay.vn';

const PKG_PRICES = { html: 299000, mp3: 299000, combo: 399000 };

/* ── KV helpers ── */
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
async function kvIncr(key) {
  const r = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['INCR', key]),
  });
  const data = await r.json();
  return data.result;
}

/* ── Resend email ── */
async function sendEmail({ to, subject, html }) {
  const fromEmail = process.env.FROM_EMAIL || 'no-reply@hanadola.com';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: fromEmail, to, subject, html }),
  });
  const text = await r.text();
  console.log('[Resend] TO:', to, '| status:', r.status, '| resp:', text);
}

/* ── SePay eInvoice ── */
async function createEInvoice({ order, transferAmount }) {
  const clientId          = process.env.SEPAY_EINVOICE_CLIENT_ID;
  const clientSecret      = process.env.SEPAY_EINVOICE_CLIENT_SECRET;
  const providerAccountId = process.env.SEPAY_EINVOICE_PROVIDER_ACCOUNT_ID;
  const templateCode      = process.env.SEPAY_EINVOICE_TEMPLATE_CODE;
  const invoiceSeries     = process.env.SEPAY_EINVOICE_SERIES;

  if (!clientId || !clientSecret || !providerAccountId) {
    console.log('[eInvoice] Thiếu biến môi trường — bỏ qua');
    return null;
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenRes = await fetch(`${EINVOICE_BASE}/v1/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
  });
  const tokenData = await tokenRes.json();
  console.log('[eInvoice] Token resp:', tokenRes.status, JSON.stringify(tokenData));
  const token = tokenData?.data?.access_token;
  if (!token) return null;

  const issuedDate = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const pkgName = order.pkgName || 'Bộ Luận Giải Nhân Sinh — Tài liệu số';

  const payload = {
    template_code:       templateCode,
    invoice_series:      invoiceSeries,
    issued_date:         issuedDate,
    currency:            'VND',
    provider_account_id: providerAccountId,
    payment_method:      'CK',
    buyer: { name: order.name, email: order.email },
    items: [{
      line_number: 1,
      line_type:   1,
      item_code:   'LGNS-001',
      item_name:   pkgName,
      unit:        'Tài liệu',
      quantity:    1,
      unit_price:  transferAmount || order.amount,
      tax_rate:    -2,
    }],
    is_draft: false,
  };

  const invoiceRes = await fetch(`${EINVOICE_BASE}/v1/invoices/create`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const invoiceData = await invoiceRes.json();
  console.log('[eInvoice] Create resp:', invoiceRes.status, JSON.stringify(invoiceData));
  return invoiceData?.data || null;
}

/* ── Webhook handler ── */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers['authorization'] || '';
  const expectedToken = process.env.SEPAY_API_KEY;
  if (expectedToken && authHeader !== `Apikey ${expectedToken}`) {
    console.warn('[Webhook] Auth thất bại:', authHeader);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body || {};
  console.log('[Webhook] Nhận:', JSON.stringify(body));

  const content = body.content || body.description || '';
  const transferAmount = Number(body.transferAmount || body.amount || 0);

  const match = content.match(ORDER_CODE_REGEX);
  if (!match) {
    console.log('[Webhook] Không tìm thấy mã LGNS trong:', content);
    return res.status(200).json({ success: false, message: 'Không tìm thấy mã đơn hàng' });
  }

  const orderCode = match[0].toUpperCase();
  console.log('[Webhook] Mã đơn:', orderCode, '| Số tiền:', transferAmount);

  const raw = await kvGet(`order:${orderCode}`);
  if (!raw) {
    console.warn('[Webhook] Không tìm thấy đơn:', orderCode);
    return res.status(200).json({ success: false, message: 'Không tìm thấy đơn hàng' });
  }

  const order = JSON.parse(raw);

  // Kiểm tra số tiền tối thiểu theo gói
  const minPrice = PKG_PRICES[order.pkg] || 299000;
  if (transferAmount < minPrice) {
    console.warn('[Webhook] Số tiền không đủ:', transferAmount, '< minPrice:', minPrice);
    return res.status(200).json({ success: false, message: 'Số tiền không đủ' });
  }

  if (order.status === 'paid') {
    console.log('[Webhook] Đơn đã thanh toán trước đó:', orderCode);
    return res.status(200).json({ success: true, message: 'Đã xử lý trước đó' });
  }

  const paidAt = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  order.status = 'paid';
  order.paidAt = paidAt;
  order.transferAmount = transferAmount;
  await kvSet(`order:${orderCode}`, JSON.stringify(order), 86400 * 30);

  const counter = await kvIncr('lgns_invoice_counter');
  const invoiceNumber = `HD-LGNS-2026-${String(counter).padStart(4, '0')}`;

  // eInvoice
  let einvoiceData = null;
  try {
    einvoiceData = await createEInvoice({ order, transferAmount });
    if (einvoiceData) {
      order.invoiceTrackingCode = einvoiceData.tracking_code || null;
      order.invoiceNumber = invoiceNumber;
      await kvSet(`order:${orderCode}`, JSON.stringify(order), 86400 * 30);
      console.log('[eInvoice] ✅ tracking_code:', einvoiceData.tracking_code);
    }
  } catch (err) {
    console.error('[eInvoice] ❌ Lỗi:', err.message);
  }

  // Xác định link giao hàng theo gói
  const pkg = order.pkg || 'combo';
  let fileUrl = process.env.FILE_URL_COMBO || '#';
  if (pkg === 'html') fileUrl = process.env.FILE_URL_HTML || process.env.FILE_URL_COMBO || '#';
  if (pkg === 'mp3')  fileUrl = process.env.FILE_URL_MP3  || process.env.FILE_URL_COMBO || '#';

  const pkgLabel = {
    html:  'Tài liệu số HTML',
    mp3:   'Học liệu âm thanh MP3',
    combo: 'Combo HTML + MP3',
  }[pkg] || 'Bộ Luận Giải Nhân Sinh';

  const amountFormatted = (transferAmount || minPrice).toLocaleString('vi-VN') + ' ₫';

  // Email khách hàng
  try {
    await sendEmail({
      to: order.email,
      subject: `✅ Thanh toán thành công — Bộ Luận Giải Nhân Sinh`,
      html: `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><style>
body{font-family:'Segoe UI',Georgia,serif;background:#0C0C12;color:#F5F0E8;margin:0;padding:0}
.wrap{max-width:520px;margin:0 auto;padding:40px 24px}
.brand{font-size:10px;letter-spacing:3px;color:rgba(201,168,76,0.6);text-transform:uppercase;margin-bottom:28px}
h1{font-size:22px;font-weight:300;margin-bottom:6px;font-family:Georgia,serif;color:#F5F0E8}
h1 em{font-style:italic;color:#E0BB6A}
p{font-size:14px;color:rgba(245,240,232,0.6);line-height:1.8;margin-bottom:14px}
.box{background:rgba(255,255,255,0.04);border:1px solid rgba(201,168,76,0.2);border-radius:8px;padding:20px 24px;margin:20px 0}
.box-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:13px}
.box-row:last-child{border-bottom:none}
.box-label{color:rgba(245,240,232,0.4)}
.box-val{color:#F5F0E8;font-weight:500}
.inv{color:#E0BB6A;font-weight:700}
.btn{display:block;background:linear-gradient(135deg,#C9A84C,#E0BB6A);color:#0C0C12;text-align:center;padding:16px;border-radius:6px;font-size:15px;font-weight:700;text-decoration:none;margin:24px 0;letter-spacing:.5px}
.note{font-size:11px;color:rgba(201,168,76,0.5);line-height:1.7}
.footer{margin-top:32px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06);font-size:11px;color:rgba(201,168,76,0.3);text-align:center}
</style></head><body><div class="wrap">
<div class="brand">Góc Tĩnh Lặng · Hanadola Media &amp; Technology</div>
<h1>Cảm ơn bạn, <em>${order.name}</em>!</h1>
<p>Thanh toán đã được xác nhận. Tài liệu của bạn đã sẵn sàng bên dưới.</p>
<div class="box">
  <div class="box-row"><span class="box-label">Sản phẩm</span><span class="box-val">Bộ Luận Giải Nhân Sinh</span></div>
  <div class="box-row"><span class="box-label">Gói</span><span class="box-val">${pkgLabel}</span></div>
  <div class="box-row"><span class="box-label">Mã đơn hàng</span><span class="box-val">${orderCode}</span></div>
  <div class="box-row"><span class="box-label">Số hóa đơn</span><span class="box-val inv">${invoiceNumber}</span></div>
  <div class="box-row"><span class="box-label">Số tiền</span><span class="box-val">${amountFormatted}</span></div>
  <div class="box-row"><span class="box-label">Thanh toán lúc</span><span class="box-val">${paidAt}</span></div>
</div>
<a href="${fileUrl}" class="btn">📥 Nhận Tài Liệu Ngay</a>
<p class="note">
  🔒 Tài liệu được cấp phép cá nhân. Vui lòng không chia sẻ hoặc phân phối lại.<br>
  Cần hỗ trợ: <strong style="color:#F5F0E8">admin@hanadola.com</strong> · 0935 251 866
</p>
<div class="footer">© 2026 Công ty TNHH Hanadola Media &amp; Technology<br>P903, Tầng 9, Diamond Plaza, 34 Lê Duẩn, TP.HCM · MST: 0319352856</div>
</div></body></html>`,
    });
  } catch (err) {
    console.error('[Email] Lỗi gửi email khách:', err.message);
  }

  // Email admin
  const notifyEmail = process.env.NOTIFY_EMAIL;
  if (notifyEmail) {
    try {
      await sendEmail({
        to: notifyEmail,
        subject: `[LGNS] Đơn hàng mới — ${orderCode} — ${order.name}`,
        html: `<div style="font-family:'Segoe UI',sans-serif;max-width:480px;padding:24px;background:#0C0C12;color:#F5F0E8;border-radius:8px">
<h2 style="color:#E0BB6A;font-size:18px;margin-bottom:16px">💰 Đơn hàng mới — Bộ Luận Giải Nhân Sinh</h2>
<table style="width:100%;border-collapse:collapse;font-size:13px">
  <tr><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);color:rgba(245,240,232,0.5);width:40%">Khách hàng</td><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-weight:600">${order.name}</td></tr>
  <tr><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);color:rgba(245,240,232,0.5)">Email</td><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)">${order.email}</td></tr>
  <tr><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);color:rgba(245,240,232,0.5)">Điện thoại</td><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)">${order.phone}</td></tr>
  <tr><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);color:rgba(245,240,232,0.5)">Gói</td><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)">${pkgLabel}</td></tr>
  <tr><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);color:rgba(245,240,232,0.5)">Mã đơn</td><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);color:#E0BB6A;font-weight:600">${orderCode}</td></tr>
  <tr><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);color:rgba(245,240,232,0.5)">Số hóa đơn</td><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);color:#E0BB6A">${invoiceNumber}</td></tr>
  <tr><td style="padding:8px 0;color:rgba(245,240,232,0.5)">Thanh toán lúc</td><td style="padding:8px 0">${paidAt}</td></tr>
</table>
</div>`,
      });
    } catch (err) {
      console.error('[Email] Lỗi gửi admin:', err.message);
    }
  }

  return res.status(200).json({ success: true, orderCode, invoiceNumber });
};
