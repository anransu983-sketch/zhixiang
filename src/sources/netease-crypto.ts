// 网易云 weapi 加密（全新写，参考 Folia 桥的思路与公开的接口行为，
// 代码不搬 Folia 的 folia.js）：
// - 参数两层 AES-CBC：先用固定 nonce 加密 JSON，再用随机 16 位密钥加密一次，
//   IV 固定为 0102030405060708，结果均为 base64。
// - 密钥保护：随机密钥倒序后按 UTF-8 取字节 → 大整数 → 以公开模数与指数
//   010001 做裸 RSA 幂运算，结果补齐 256 位十六进制（encSecKey）。
// - 传输走原生 HTTP 桥 POST 表单（params＋encSecKey），不依赖任何外部服务器。

const MODULUS =
    '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const NONCE = '0CoJUm6Qyw8W8jud';
const PUBKEY = '010001';
const IV_TEXT = '0102030405060708';
const KEY_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomSecretKey(): string {
    let key = '';
    for (let i = 0; i < 16; i++) {
        key += KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)];
    }
    return key;
}

function bufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

async function aesCbcBase64(text: string, key: string): Promise<string> {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(key),
        { name: 'AES-CBC' },
        false,
        ['encrypt']
    );
    const cipher = await crypto.subtle.encrypt(
        { name: 'AES-CBC', iv: new TextEncoder().encode(IV_TEXT) },
        cryptoKey,
        new TextEncoder().encode(text)
    );
    return bufferToBase64(cipher);
}

function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
    let result = 1n;
    let b = base % mod;
    let e = exp;
    while (e > 0n) {
        if (e & 1n) {
            result = (result * b) % mod;
        }
        b = (b * b) % mod;
        e >>= 1n;
    }
    return result;
}

function rsaEncryptHex(text: string): string {
    const reversed = [...text].reverse().join('');
    const hex = [...new TextEncoder().encode(reversed)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    const value = modpow(BigInt(`0x${hex}`), BigInt(`0x${PUBKEY}`), BigInt(`0x${MODULUS}`));
    return value.toString(16).padStart(256, '0');
}

// weapi 加密：返回可直接拼成表单体的 params 与 encSecKey。
export async function weapiEncrypt(data: Record<string, unknown>): Promise<{
    params: string;
    encSecKey: string;
}> {
    const secretKey = randomSecretKey();
    const first = await aesCbcBase64(JSON.stringify(data), NONCE);
    const params = await aesCbcBase64(first, secretKey);
    return { params, encSecKey: rsaEncryptHex(secretKey) };
}
