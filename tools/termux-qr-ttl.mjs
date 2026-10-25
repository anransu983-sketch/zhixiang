// Termux 单 key 寿命测试（Claude 2026-10-25 实验）：与芷湘 App 完全相同的
// eapi 取码 + 3 秒轮询，在手机本机跑，看 key 多少秒变 800。
// 用法（Termux 里）：node termux-qr-ttl.mjs（若无 node，先 pkg install nodejs）。
// 只打印状态与寿命，不打印任何 cookie 值；出口 IP 只打一行，供对照。
import crypto from 'node:crypto';

const EAPI_KEY = 'e82ckenh8dichen8';
const EAPI_BASE = 'https://interface.music.163.com';
const EAPI_UA = 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)';
const rnd = (n, alpha) => Array.from({ length: n }, () => alpha[Math.floor(Math.random() * alpha.length)]).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dev = {
    deviceId: rnd(16, 'abcdefghijklmnopqrstuvwxyz0123456789'),
    nuid: rnd(32, '0123456789abcdef'),
    wnmcid: '',
    nmtid: ''
};
const now0 = Date.now();
dev.wnmcid = `${rnd(6, 'abcdefghijklmnopqrstuvwxyz')}.${now0}.01.0`;

function buildHeader() {
    const now = Date.now();
    const h = {
        osver: '16.2', deviceId: dev.deviceId, appver: '9.0.90', versioncode: '140',
        mobilename: '', buildver: String(now).slice(0, 10), resolution: '1920x1080',
        __csrf: '', os: 'iPhone OS', channel: 'distribution',
        requestId: `${now}_${String(Math.floor(Math.random() * 1000)).padStart(4, '0')}`,
        _ntes_nuid: dev.nuid, _ntes_nnid: `${dev.nuid},${now}`, WNMCID: dev.wnmcid,
        WEVNSM: '1.0.0', __remember_me: 'true', ntes_kaola_ad: '1'
    };
    if (dev.nmtid) h.NMTID = dev.nmtid;
    return h;
}

function eapiEncrypt(uri, body) {
    const text = JSON.stringify(body);
    const digest = crypto.createHash('md5').update(`nobody${uri}use${text}md5forencrypt`, 'utf8').digest('hex');
    const payload = `${uri}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
    const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(EAPI_KEY, 'utf8'), null);
    return Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]).toString('hex').toUpperCase();
}

async function eapi(path, data) {
    const uri = path.startsWith('/api/') ? path : `/api/${path.replace(/^\//, '')}`;
    const apiPath = uri.slice(5);
    const header = buildHeader();
    const params = eapiEncrypt(uri, { ...data, header });
    const cookie = Object.entries(header).filter(([, v]) => v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('; ');
    const resp = await fetch(`${EAPI_BASE}/eapi/${apiPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': EAPI_UA, 'Cookie': cookie },
        body: `params=${encodeURIComponent(params)}`
    });
    const text = await resp.text();
    const sc = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
    const m = sc.join('; ').match(/(?:^|;\s*)NMTID=([^;]+)/);
    if (m && m[1]) dev.nmtid = m[1];
    let body = {};
    try { body = JSON.parse(text); } catch { body = {}; }
    return { status: resp.status, body };
}

try {
    const ipResp = await fetch('https://api.ip.sb/ip');
    console.log('出口 IP：' + (await ipResp.text()).trim());
} catch {
    console.log('出口 IP：取不到');
}

const k = await eapi('/api/login/qrcode/unikey', { type: 3 });
const key = k.body.unikey || k.body.uniKey || (k.body.data && (k.body.data.unikey || k.body.data.uniKey)) || '';
console.log(`取码：HTTP ${k.status} code=${k.body.code} 有key=${!!key}`);
if (!key) process.exit(1);
const t0 = Date.now();
for (let i = 0; i < 80; i++) {
    await sleep(3000);
    const c = await eapi('/api/login/qrcode/client/login', { key, type: 3 });
    const code = Number(c.body.code || 0);
    if (code === 800) {
        console.log(`结论：key 在 ${Math.round((Date.now() - t0) / 1000)} 秒后变 800`);
        process.exit(0);
    }
    if (code !== 801 && code !== 802) console.log(`轮询第 ${i + 1} 次 code=${code}`);
}
console.log('结论：240 秒仍未变 800');
