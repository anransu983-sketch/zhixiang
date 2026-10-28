package com.suanran.zhixiang;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * 内嵌歌词读取（0.1.103，纯 Java、无第三方依赖，读不到就回 null，不抛错给调用方）：
 * - 同目录同名 .lrc（用户自放的歌词文件，多数是带时间轴的同步词）；
 * - MP3 的 ID3v2 USLT（v2.3/v2.4；v2.2 的 ULT 跳过）；
 * - FLAC 的 VORBIS_COMMENT 里 LYRICS / UNSYNCEDLYRICS；
 * - M4A/MP4 的 moov/udta/meta/ilst/©lyr。
 * OGG、SYLT 同步词、APEv2、ID3v1 暂不支持。所有读取都有上限，
 * 大文件只读标签区、不整文件进内存；读失败一律当无词处理。
 */
public final class EmbeddedLyrics {

    public static final class Result {
        public final String text;
        public final String source;

        public Result(String text, String source) {
            this.text = text;
            this.source = source;
        }
    }

    private static final int MAX_TAG_BYTES = 16 * 1024 * 1024;
    private static final int MAX_SIDECAR_BYTES = 1024 * 1024;
    private static final long MAX_MP4_SCAN_BYTES = 64L * 1024 * 1024;

    private EmbeddedLyrics() {
    }

    public static Result read(String path) {
        if (path == null || path.isEmpty()) {
            return null;
        }
        try {
            Result sidecar = readSidecar(path);
            if (sidecar != null) {
                return sidecar;
            }
            String lower = path.toLowerCase();
            if (lower.endsWith(".mp3")) {
                return readId3(path);
            }
            if (lower.endsWith(".flac")) {
                return readFlac(path);
            }
            if (lower.endsWith(".m4a") || lower.endsWith(".mp4") || lower.endsWith(".m4b")) {
                return readMp4(path);
            }
            // 未知后缀：只试带魔数的两种（ID3/FLAC），MP4 原子漫步成本高，跳过。
            Result id3 = readId3(path);
            if (id3 != null) {
                return id3;
            }
            return readFlac(path);
        } catch (Exception e) {
            return null;
        }
    }

    private static Result readSidecar(String path) throws IOException {
        int dot = path.lastIndexOf('.');
        int slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        if (dot <= slash) {
            return null;
        }
        String lrcPath = path.substring(0, dot) + ".lrc";
        File file = new File(lrcPath);
        if (!file.isFile() || file.length() <= 0 || file.length() > MAX_SIDECAR_BYTES) {
            return null;
        }
        byte[] bytes = new byte[(int) file.length()];
        try (FileInputStream in = new FileInputStream(file)) {
            if (readFully(in, bytes, 0, bytes.length) < bytes.length) {
                return null;
            }
        }
        String text = new String(bytes, StandardCharsets.UTF_8).trim();
        if (text.startsWith("\uFEFF")) {
            text = text.substring(1);
        }
        return text.isEmpty() ? null : new Result(text, "sidecar");
    }

    private static Result readId3(String path) throws IOException {
        File file = new File(path);
        if (!file.isFile()) {
            return null;
        }
        byte[] head = new byte[10];
        try (FileInputStream in = new FileInputStream(file)) {
            if (readFully(in, head, 0, 10) < 10) {
                return null;
            }
        }
        if (head[0] != 'I' || head[1] != 'D' || head[2] != '3') {
            return null;
        }
        int version = head[3] & 0xFF;
        if (version < 3 || version > 4) {
            return null;
        }
        int flags = head[5] & 0xFF;
        int tagSize = synchsafe(head, 6);
        if (tagSize <= 0 || tagSize > MAX_TAG_BYTES) {
            return null;
        }
        byte[] tag = new byte[tagSize];
        try (FileInputStream in = new FileInputStream(file)) {
            in.skip(10);
            if (readFully(in, tag, 0, tagSize) < tagSize) {
                return null;
            }
        }
        byte[] data = tag;
        if ((flags & 0x80) != 0) {
            data = deunsync(tag);
        }
        int pos = 0;
        if ((flags & 0x40) != 0) {
            // 扩展头：v2.3 的 size 不含自身 4 字节，v2.4 的 size 含自身。
            if (data.length < 4) {
                return null;
            }
            int extSize = version == 4 ? synchsafe(data, 0) : be32(data, 0);
            pos = version == 4 ? extSize : 4 + extSize;
            if (pos < 0 || pos > data.length) {
                return null;
            }
        }
        while (pos + 10 <= data.length) {
            String id = new String(data, pos, 4, StandardCharsets.ISO_8859_1);
            if (id.charAt(0) == 0) {
                break; // 填充区
            }
            int size = version == 4 ? synchsafe(data, pos + 4) : be32(data, pos + 4);
            int payloadStart = pos + 10;
            if (size < 0 || payloadStart + size > data.length) {
                break;
            }
            if ("USLT".equals(id)) {
                String text = parseUslt(data, payloadStart, size);
                if (text != null && !text.trim().isEmpty()) {
                    return new Result(text.trim(), "id3");
                }
            }
            pos = payloadStart + size;
        }
        return null;
    }

    private static String parseUslt(byte[] data, int start, int size) {
        if (size < 5) {
            return null;
        }
        int enc = data[start] & 0xFF;
        int p = start + 4; // 跳过编码字节 + 3 字节语言
        int end = start + size;
        if (enc == 0 || enc == 3) {
            while (p < end && data[p] != 0) {
                p++;
            }
            p++; // 跳过单字节 0
        } else {
            // UTF-16 描述符以 00 00 结尾，描述符从偶数偏移起，步进 2。
            while (p + 1 < end && !(data[p] == 0 && data[p + 1] == 0)) {
                p += 2;
            }
            p += 2;
        }
        if (p >= end) {
            return null;
        }
        byte[] raw = Arrays.copyOfRange(data, p, end);
        String text = decodeText(raw, enc);
        if (text == null) {
            return null;
        }
        int cut = text.length();
        while (cut > 0 && text.charAt(cut - 1) == 0) {
            cut--;
        }
        return text.substring(0, cut);
    }

    private static String decodeText(byte[] raw, int enc) {
        try {
            switch (enc) {
                case 0:
                    return new String(raw, StandardCharsets.ISO_8859_1);
                case 1:
                    if (raw.length >= 2 && raw[0] == (byte) 0xFF && raw[1] == (byte) 0xFE) {
                        return new String(raw, 2, raw.length - 2, StandardCharsets.UTF_16LE);
                    }
                    if (raw.length >= 2 && raw[0] == (byte) 0xFE && raw[1] == (byte) 0xFF) {
                        return new String(raw, 2, raw.length - 2, StandardCharsets.UTF_16BE);
                    }
                    return new String(raw, StandardCharsets.UTF_16LE);
                case 2:
                    return new String(raw, StandardCharsets.UTF_16BE);
                case 3:
                    return new String(raw, StandardCharsets.UTF_8);
                default:
                    return null;
            }
        } catch (Exception e) {
            return null;
        }
    }

    private static Result readFlac(String path) throws IOException {
        File file = new File(path);
        if (!file.isFile()) {
            return null;
        }
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] magic = new byte[4];
            if (readFully(in, magic, 0, 4) < 4) {
                return null;
            }
            if (!"fLaC".equals(new String(magic, StandardCharsets.ISO_8859_1))) {
                return null;
            }
            long scanned = 4;
            for (int block = 0; block < 64; block++) {
                byte[] header = new byte[4];
                if (readFully(in, header, 0, 4) < 4) {
                    return null;
                }
                boolean last = (header[0] & 0x80) != 0;
                int type = header[0] & 0x7F;
                int len = ((header[1] & 0xFF) << 16) | ((header[2] & 0xFF) << 8)
                        | (header[3] & 0xFF);
                scanned += 4;
                if (len < 0 || scanned + len > 8 * 1024 * 1024) {
                    return null;
                }
                if (type == 4) {
                    String text = parseVorbisComment(in, len);
                    if (text != null && !text.trim().isEmpty()) {
                        return new Result(text.trim(), "flac");
                    }
                    return null;
                }
                long skipped = 0;
                while (skipped < len) {
                    long n = in.skip(len - skipped);
                    if (n <= 0) {
                        return null;
                    }
                    skipped += n;
                }
                scanned += len;
                if (last) {
                    return null;
                }
            }
            return null;
        }
    }

    private static String parseVorbisComment(InputStream in, int len) throws IOException {
        byte[] block = new byte[len];
        if (readFully(in, block, 0, len) < len) {
            return null;
        }
        int pos = 0;
        if (len < 8) {
            return null;
        }
        int vendorLen = le32(block, pos);
        pos += 4;
        if (vendorLen < 0 || pos + vendorLen + 4 > len) {
            return null;
        }
        pos += vendorLen;
        int count = le32(block, pos);
        pos += 4;
        for (int i = 0; i < count; i++) {
            if (pos + 4 > len) {
                return null;
            }
            int clen = le32(block, pos);
            pos += 4;
            if (clen < 0 || pos + clen > len) {
                return null;
            }
            String comment = new String(block, pos, clen, StandardCharsets.UTF_8);
            pos += clen;
            int eq = comment.indexOf('=');
            if (eq > 0) {
                String key = comment.substring(0, eq).toUpperCase();
                if ("LYRICS".equals(key) || "UNSYNCEDLYRICS".equals(key)) {
                    String value = comment.substring(eq + 1);
                    if (!value.trim().isEmpty()) {
                        return value;
                    }
                }
            }
        }
        return null;
    }

    private static Result readMp4(String path) throws IOException {
        File file = new File(path);
        if (!file.isFile()) {
            return null;
        }
        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            return scanMp4Atoms(raf, 0, raf.length(), 0);
        }
    }

    private static Result scanMp4Atoms(RandomAccessFile raf, long start, long end, int depth)
            throws IOException {
        if (depth > 8 || end - start < 8) {
            return null;
        }
        long pos = start;
        while (pos + 8 <= end && pos < MAX_MP4_SCAN_BYTES) {
            raf.seek(pos);
            long size = raf.readInt() & 0xFFFFFFFFL;
            byte[] typeBytes = new byte[4];
            raf.readFully(typeBytes);
            String type = new String(typeBytes, StandardCharsets.ISO_8859_1);
            long headerLen = 8;
            if (size == 1) {
                size = raf.readLong();
                headerLen = 16;
            } else if (size == 0) {
                size = end - pos;
            }
            if (size < headerLen || pos + size > end) {
                return null;
            }
            long contentStart = pos + headerLen;
            long contentEnd = pos + size;
            if ("meta".equals(type)) {
                // meta 子项前有 4 字节 version/flags。
                Result found = scanMp4Atoms(raf, contentStart + 4, contentEnd, depth + 1);
                if (found != null) {
                    return found;
                }
            } else if ("moov".equals(type) || "udta".equals(type) || "ilst".equals(type)
                    || "trak".equals(type) || "mdia".equals(type) || "minf".equals(type)
                    || "stbl".equals(type)) {
                Result found = scanMp4Atoms(raf, contentStart, contentEnd, depth + 1);
                if (found != null) {
                    return found;
                }
            } else if (typeBytes[0] == (byte) 0xA9 && typeBytes[1] == 'l'
                    && typeBytes[2] == 'y' && typeBytes[3] == 'r') {
                // ©lyr：里面是 data 原子：8 字节头 + 4 字节类型 + 4 字节 locale + 文本。
                raf.seek(contentStart);
                long dataSize = raf.readInt() & 0xFFFFFFFFL;
                byte[] dataType = new byte[4];
                raf.readFully(dataType);
                if ("data".equals(new String(dataType, StandardCharsets.ISO_8859_1))
                        && dataSize >= 16 && contentStart + dataSize <= contentEnd) {
                    raf.seek(contentStart + 16);
                    byte[] textBytes = new byte[(int) (dataSize - 16)];
                    raf.readFully(textBytes);
                    String text = new String(textBytes, StandardCharsets.UTF_8).trim();
                    if (!text.isEmpty()) {
                        return new Result(text, "mp4");
                    }
                }
            }
            pos = contentEnd;
        }
        return null;
    }

    private static byte[] deunsync(byte[] tag) {
        byte[] out = new byte[tag.length];
        int o = 0;
        for (int i = 0; i < tag.length; i++) {
            out[o++] = tag[i];
            if (tag[i] == (byte) 0xFF && i + 1 < tag.length && tag[i + 1] == 0) {
                i++; // 丢掉填充的 0x00
            }
        }
        return Arrays.copyOf(out, o);
    }

    private static int readFully(InputStream in, byte[] buf, int off, int len)
            throws IOException {
        int total = 0;
        while (total < len) {
            int n = in.read(buf, off + total, len - total);
            if (n < 0) {
                break;
            }
            total += n;
        }
        return total;
    }

    private static int synchsafe(byte[] buf, int off) {
        return ((buf[off] & 0x7F) << 21) | ((buf[off + 1] & 0x7F) << 14)
                | ((buf[off + 2] & 0x7F) << 7) | (buf[off + 3] & 0x7F);
    }

    private static int be32(byte[] buf, int off) {
        return ((buf[off] & 0xFF) << 24) | ((buf[off + 1] & 0xFF) << 16)
                | ((buf[off + 2] & 0xFF) << 8) | (buf[off + 3] & 0xFF);
    }

    private static int le32(byte[] buf, int off) {
        return (buf[off] & 0xFF) | ((buf[off + 1] & 0xFF) << 8)
                | ((buf[off + 2] & 0xFF) << 16) | ((buf[off + 3] & 0xFF) << 24);
    }
}
